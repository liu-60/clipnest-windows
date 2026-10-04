param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][int]$ExpectedWidth,
  [Parameter(Mandatory = $true)][int]$ExpectedHeight
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;

public static class ClipNestT04GdiPlusProbe
{
    private const uint LoadLibrarySearchSystem32 = 0x00000800;
    private const uint PixelFormat32bppArgb = 0x0026200A;
    private const uint ImageLockModeRead = 0x00000001;
    private const int MaximumChannelError = 24;
    private const double MaximumMeanAbsoluteError = 3.0;
    private static string stage = "initialize";

    [StructLayout(LayoutKind.Sequential)]
    private struct GdiplusStartupInput
    {
        public uint GdiplusVersion;
        public IntPtr DebugEventCallback;
        public int SuppressBackgroundThread;
        public int SuppressExternalCodecs;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int X;
        public int Y;
        public int Width;
        public int Height;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapData
    {
        public uint Width;
        public uint Height;
        public int Stride;
        public int PixelFormat;
        public IntPtr Scan0;
        public IntPtr Reserved;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GdiplusStartupDelegate(out IntPtr token, ref GdiplusStartupInput input, IntPtr output);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void GdiplusShutdownDelegate(IntPtr token);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int LoadImageFromStreamDelegate(IntPtr stream, out IntPtr image);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetImageDimensionDelegate(IntPtr image, out uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int BitmapLockBitsDelegate(IntPtr image, ref Rect rect, uint flags, uint pixelFormat, ref BitmapData data);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int BitmapUnlockBitsDelegate(IntPtr image, ref BitmapData data);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int DisposeImageDelegate(IntPtr image);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern uint GetModuleFileNameW(IntPtr module, StringBuilder fileName, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(IntPtr module);
    [DllImport("ole32.dll", PreserveSig = true, ExactSpelling = true)]
    private static extern int CreateStreamOnHGlobal(IntPtr global, [MarshalAs(UnmanagedType.Bool)] bool deleteOnRelease, out IStream stream);

    private static T GetDelegate<T>(IntPtr module, string name) where T : class
    {
        IntPtr address = GetProcAddress(module, name);
        if (address == IntPtr.Zero)
            throw new InvalidOperationException("gdiplus_export_missing:" + name + ":" + Marshal.GetLastWin32Error());
        return (T)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(T));
    }

    public static Dictionary<string, object> Run(string imagePath, int expectedWidth, int expectedHeight)
    {
        var result = new Dictionary<string, object>();
        IntPtr module = IntPtr.Zero;
        IntPtr startupToken = IntPtr.Zero;
        IntPtr image = IntPtr.Zero;
        IntPtr hglobal = IntPtr.Zero;
        IntPtr streamPointer = IntPtr.Zero;
        IStream stream = null;
        bool started = false;
        bool locked = false;
        BitmapData bitmapData = new BitmapData();
        GdiplusShutdownDelegate shutdown = null;
        BitmapUnlockBitsDelegate unlockBits = null;
        DisposeImageDelegate disposeImage = null;

        long workingSetBeforeBytes = 0;
        long privateBytesBefore = 0;
        long elapsedMilliseconds = 0;
        long totalAbsoluteError = 0;
        int maxAbsoluteError = 0;
        long alphaMismatchCount = 0;
        long checkedPixels = 0;
        string modulePath = null;
        string inputSha256 = null;
        string failure = null;
        bool passed = false;

        try
        {
            stage = "validate_process_and_input";
            if (!Environment.Is64BitProcess || Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new InvalidOperationException("probe_requires_windows_x64");
            if (expectedWidth <= 0 || expectedHeight <= 0 || (long)expectedWidth * expectedHeight != 16000000L)
                throw new InvalidOperationException("probe_requires_16mp_dimensions");
            imagePath = Path.GetFullPath(imagePath);
            byte[] encoded = File.ReadAllBytes(imagePath);
            using (SHA256 sha = SHA256.Create())
                inputSha256 = BitConverter.ToString(sha.ComputeHash(encoded)).Replace("-", "").ToLowerInvariant();

            stage = "load_system32_gdiplus";
            module = LoadLibraryExW("gdiplus.dll", IntPtr.Zero, LoadLibrarySearchSystem32);
            if (module == IntPtr.Zero)
                throw new InvalidOperationException("gdiplus_load_library_search_system32_failed:" + Marshal.GetLastWin32Error());
            var modulePathBuffer = new StringBuilder(32768);
            uint modulePathLength = GetModuleFileNameW(module, modulePathBuffer, (uint)modulePathBuffer.Capacity);
            if (modulePathLength == 0 || modulePathLength >= (uint)modulePathBuffer.Capacity)
                throw new InvalidOperationException("gdiplus_module_path_unavailable:" + Marshal.GetLastWin32Error());
            modulePath = Path.GetFullPath(modulePathBuffer.ToString());
            string expectedSystemDll = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "gdiplus.dll"));
            if (!String.Equals(modulePath, expectedSystemDll, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("gdiplus_loaded_path_not_system32:" + modulePath);

            var startup = GetDelegate<GdiplusStartupDelegate>(module, "GdiplusStartup");
            shutdown = GetDelegate<GdiplusShutdownDelegate>(module, "GdiplusShutdown");
            var loadImageFromStream = GetDelegate<LoadImageFromStreamDelegate>(module, "GdipLoadImageFromStream");
            var getWidth = GetDelegate<GetImageDimensionDelegate>(module, "GdipGetImageWidth");
            var getHeight = GetDelegate<GetImageDimensionDelegate>(module, "GdipGetImageHeight");
            var lockBits = GetDelegate<BitmapLockBitsDelegate>(module, "GdipBitmapLockBits");
            unlockBits = GetDelegate<BitmapUnlockBitsDelegate>(module, "GdipBitmapUnlockBits");
            disposeImage = GetDelegate<DisposeImageDelegate>(module, "GdipDisposeImage");

            stage = "gdiplus_startup";
            GdiplusStartupInput startupInput = new GdiplusStartupInput();
            startupInput.GdiplusVersion = 1;
            if (startup(out startupToken, ref startupInput, IntPtr.Zero) != 0 || startupToken == IntPtr.Zero)
                throw new InvalidOperationException("gdiplus_startup_failed");
            started = true;

            stage = "create_memory_stream";
            hglobal = Marshal.AllocHGlobal(encoded.Length);
            Marshal.Copy(encoded, 0, hglobal, encoded.Length);
            int streamStatus = CreateStreamOnHGlobal(hglobal, true, out stream);
            if (streamStatus < 0 || stream == null)
                throw new InvalidOperationException("CreateStreamOnHGlobal_failed:0x" + streamStatus.ToString("X8"));
            hglobal = IntPtr.Zero;
            streamPointer = Marshal.GetComInterfaceForObject(stream, typeof(IStream));
            if (streamPointer == IntPtr.Zero)
                throw new InvalidOperationException("memory_stream_iid_unavailable");

            using (Process current = Process.GetCurrentProcess())
            {
                current.Refresh();
                workingSetBeforeBytes = current.WorkingSet64;
                privateBytesBefore = current.PrivateMemorySize64;
            }

            stage = "load_jpeg_from_memory_stream";
            var timer = Stopwatch.StartNew();
            int loadStatus = loadImageFromStream(streamPointer, out image);
            if (loadStatus != 0 || image == IntPtr.Zero)
                throw new InvalidOperationException("GdipLoadImageFromStream_failed:" + loadStatus);

            uint actualWidth;
            uint actualHeight;
            if (getWidth(image, out actualWidth) != 0 || getHeight(image, out actualHeight) != 0)
                throw new InvalidOperationException("gdiplus_image_dimensions_failed");
            if (actualWidth != (uint)expectedWidth || actualHeight != (uint)expectedHeight)
                throw new InvalidOperationException("gdiplus_image_dimensions_mismatch:" + actualWidth + "x" + actualHeight);

            stage = "lock_full_image_pixels";
            Rect rect = new Rect { X = 0, Y = 0, Width = expectedWidth, Height = expectedHeight };
            int lockStatus = lockBits(image, ref rect, ImageLockModeRead, PixelFormat32bppArgb, ref bitmapData);
            if (lockStatus != 0)
                throw new InvalidOperationException("GdipBitmapLockBits_failed:" + lockStatus);
            locked = true;
            int rowBytes = checked(expectedWidth * 4);
            if (bitmapData.Width != (uint)expectedWidth || bitmapData.Height != (uint)expectedHeight)
                throw new InvalidOperationException("gdiplus_lock_dimensions_mismatch");
            if (bitmapData.Scan0 == IntPtr.Zero || bitmapData.Stride < rowBytes)
                throw new InvalidOperationException("gdiplus_lock_stride_unsupported:" + bitmapData.Stride);

            stage = "verify_full_pixel_oracle";
            byte[] row = new byte[rowBytes];
            for (int y = 0; y < expectedHeight; y++)
            {
                IntPtr rowPointer = new IntPtr(bitmapData.Scan0.ToInt64() + (long)y * bitmapData.Stride);
                Marshal.Copy(rowPointer, row, 0, rowBytes);
                for (int x = 0; x < expectedWidth; x++)
                {
                    int offset = x * 4;
                    int expectedR = 32 + (int)((long)x * 80L / expectedWidth);
                    int expectedG = 96 + (int)((long)y * 80L / expectedHeight);
                    int expectedB = 48 + (int)((long)(x + y) * 80L / (expectedWidth + (long)expectedHeight));
                    int deltaB = Math.Abs(row[offset] - expectedB);
                    int deltaG = Math.Abs(row[offset + 1] - expectedG);
                    int deltaR = Math.Abs(row[offset + 2] - expectedR);
                    int deltaA = Math.Abs(row[offset + 3] - 255);
                    int max = Math.Max(Math.Max(deltaR, deltaG), Math.Max(deltaB, deltaA));
                    if (max > maxAbsoluteError) maxAbsoluteError = max;
                    totalAbsoluteError += deltaR + deltaG + deltaB;
                    if (deltaA != 0) alphaMismatchCount++;
                    checkedPixels++;
                }
            }
            timer.Stop();
            elapsedMilliseconds = timer.ElapsedMilliseconds;
            double meanAbsoluteError = (double)totalAbsoluteError / (checkedPixels * 3L);
            if (checkedPixels != (long)expectedWidth * expectedHeight)
                throw new InvalidOperationException("gdiplus_pixel_count_mismatch:" + checkedPixels);
            if (alphaMismatchCount != 0 || maxAbsoluteError > MaximumChannelError || meanAbsoluteError > MaximumMeanAbsoluteError)
                throw new InvalidOperationException("independent_pixel_oracle_failed:max=" + maxAbsoluteError + ":mean=" + meanAbsoluteError.ToString("F6", System.Globalization.CultureInfo.InvariantCulture) + ":alphaMismatch=" + alphaMismatchCount);
            passed = true;
        }
        catch (Exception ex)
        {
            failure = ex.GetType().FullName + ":" + ex.Message;
        }
        finally
        {
            try
            {
                if (locked && image != IntPtr.Zero && unlockBits != null)
                {
                    int status = unlockBits(image, ref bitmapData);
                    if (status != 0 && failure == null) failure = "GdipBitmapUnlockBits_failed:" + status;
                }
            }
            catch (Exception ex) { if (failure == null) failure = "unlock_failed:" + ex.Message; }
            try
            {
                if (image != IntPtr.Zero && disposeImage != null)
                {
                    int status = disposeImage(image);
                    if (status != 0 && failure == null) failure = "GdipDisposeImage_failed:" + status;
                }
            }
            catch (Exception ex) { if (failure == null) failure = "dispose_image_failed:" + ex.Message; }
            try { if (streamPointer != IntPtr.Zero) Marshal.Release(streamPointer); }
            catch (Exception ex) { if (failure == null) failure = "release_stream_pointer_failed:" + ex.Message; }
            try { if (stream != null) Marshal.ReleaseComObject(stream); }
            catch (Exception ex) { if (failure == null) failure = "release_stream_failed:" + ex.Message; }
            try { if (hglobal != IntPtr.Zero) Marshal.FreeHGlobal(hglobal); }
            catch (Exception ex) { if (failure == null) failure = "free_memory_stream_failed:" + ex.Message; }
            try { if (started && shutdown != null) shutdown(startupToken); }
            catch (Exception ex) { if (failure == null) failure = "gdiplus_shutdown_failed:" + ex.Message; }
            try { if (module != IntPtr.Zero && !FreeLibrary(module) && failure == null) failure = "gdiplus_free_library_failed:" + Marshal.GetLastWin32Error(); }
            catch (Exception ex) { if (failure == null) failure = "gdiplus_free_library_exception:" + ex.Message; }
        }

        using (Process current = Process.GetCurrentProcess())
        {
            current.Refresh();
            result["workingSetAfterBytes"] = current.WorkingSet64;
            result["privateBytesAfter"] = current.PrivateMemorySize64;
            result["peakWorkingSetBytes"] = current.PeakWorkingSet64;
            result["peakPagedMemoryBytes"] = current.PeakPagedMemorySize64;
            result["processId"] = current.Id;
        }
        result["result"] = passed && failure == null ? "PASS" : "FAILED";
        result["failureStage"] = passed && failure == null ? null : stage;
        result["failure"] = failure;
        result["gdiplusModulePath"] = modulePath;
        result["loaderFlag"] = "LOAD_LIBRARY_SEARCH_SYSTEM32 (0x00000800)";
        result["inputSha256"] = inputSha256;
        result["workingSetBeforeBytes"] = workingSetBeforeBytes;
        result["privateBytesBefore"] = privateBytesBefore;
        result["decodeAndFullScanMs"] = elapsedMilliseconds;
        result["decodedPixelCountVerified"] = checkedPixels;
        result["maxChannelAbsoluteError"] = maxAbsoluteError;
        result["meanRgbAbsoluteError"] = checkedPixels == 0 ? null : (object)((double)totalAbsoluteError / (checkedPixels * 3L));
        result["alphaMismatchCount"] = alphaMismatchCount;
        result["memorySource"] = "CreateStreamOnHGlobal IStream populated with synthetic JPEG bytes; GdipLoadImageFromStream; full-image GdipBitmapLockBits";
        result["workerArchitecture"] = Environment.Is64BitProcess ? "x64" : "x86";
        result["powershellClrVersion"] = Environment.Version.ToString();
        return result;
    }
}
'@

$childResult = $null
try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp
  $childResult = [ClipNestT04GdiPlusProbe]::Run($ImagePath, $ExpectedWidth, $ExpectedHeight)
} catch {
  $childResult = @{
    result = 'FAILED'
    failureStage = 'compile_or_invoke_probe'
    failure = $_.Exception.GetType().FullName + ':' + $_.Exception.Message
    processId = $PID
    powershellClrVersion = [Environment]::Version.ToString()
  }
}
$childResult | ConvertTo-Json -Compress -Depth 8
if ($childResult.result -ne 'PASS') { exit 1 }
