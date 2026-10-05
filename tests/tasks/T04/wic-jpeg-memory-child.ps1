param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][int]$ExpectedWidth,
  [Parameter(Mandatory = $true)][int]$ExpectedHeight
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$probeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

public static class ClipNestT04WicJpegProbe
{
    public static Dictionary<string, object> Run(string imagePath, int expectedWidth, int expectedHeight)
    {
        var result = new Dictionary<string, object>();
        string stage = "validate_process_and_input";
        string failure = null;
        byte[] encoded = null;
        byte[] pixels = null;
        long workingSetBefore = 0;
        long privateBytesBefore = 0;
        long workingSetAfter = 0;
        long privateBytesAfter = 0;
        long peakWorkingSet = 0;
        long peakPagedMemory = 0;
        long sampledPeakPrivate = 0;
        long sampledPeakWorkingSet = 0;
        long sampledPrivate = 0;
        long sampledWorking = 0;
        long decodedPixels = 0;
        long alphaMismatchCount = 0;
        long totalRgbError = 0;
        int maxRgbChannelError = 0;
        int actualWidth = 0;
        int actualHeight = 0;
        int frameCount = 0;
        string inputSha256 = null;
        string outputSha256 = null;
        double decodeCopyAndScanMs = 0;
        var crossCheckPoints = new List<Dictionary<string, object>>();
        var stopSampling = new ManualResetEvent(false);
        Thread sampler = null;

        try
        {
            if (!Environment.Is64BitProcess || Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new InvalidOperationException("probe_requires_windows_x64");
            if (expectedWidth <= 0 || expectedHeight <= 0 || (long)expectedWidth * expectedHeight != 16000000L)
                throw new InvalidOperationException("probe_requires_16mp_dimensions");
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw new InvalidOperationException("probe_requires_sta_for_wpf_imaging");

            imagePath = Path.GetFullPath(imagePath);
            stage = "read_synthetic_jpeg";
            encoded = File.ReadAllBytes(imagePath);
            using (SHA256 sha = SHA256.Create())
                inputSha256 = BitConverter.ToString(sha.ComputeHash(encoded)).Replace("-", "").ToLowerInvariant();

            using (Process current = Process.GetCurrentProcess())
            {
                current.Refresh();
                workingSetBefore = current.WorkingSet64;
                privateBytesBefore = current.PrivateMemorySize64;
            }

            sampler = new Thread(delegate()
            {
                try
                {
                    using (Process current = Process.GetCurrentProcess())
                    {
                        while (!stopSampling.WaitOne(25))
                        {
                            current.Refresh();
                            UpdateMaximum(ref sampledPrivate, current.PrivateMemorySize64);
                            UpdateMaximum(ref sampledWorking, current.WorkingSet64);
                        }
                    }
                }
                catch { }
            });
            sampler.IsBackground = true;
            sampler.Name = "ClipNest-T04-WIC-memory-sampler";
            sampler.Start();

            stage = "decode_and_copy_pixels";
            var timer = Stopwatch.StartNew();
            using (var stream = new MemoryStream(encoded, false))
            {
                // Keep the memory stream alive through CopyPixels. None avoids WPF's separate
                // full-image bitmap cache; the codec may still allocate internal frame/cache data.
                var decoder = new JpegBitmapDecoder(stream, BitmapCreateOptions.None, BitmapCacheOption.None);
                frameCount = decoder.Frames.Count;
                if (frameCount != 1) throw new InvalidOperationException("jpeg_frame_count_mismatch:" + frameCount);
                BitmapSource frame = decoder.Frames[0];
                actualWidth = frame.PixelWidth;
                actualHeight = frame.PixelHeight;
                if (actualWidth != expectedWidth || actualHeight != expectedHeight)
                    throw new InvalidOperationException("jpeg_dimensions_mismatch:" + actualWidth + "x" + actualHeight);

                var converted = new FormatConvertedBitmap(frame, PixelFormats.Bgra32, null, 0);
                if (converted.Format != PixelFormats.Bgra32)
                    throw new InvalidOperationException("bgra32_conversion_not_applied");

                int rowBytes = checked(expectedWidth * 4);
                pixels = new byte[checked(rowBytes * expectedHeight)];
                converted.CopyPixels(new Int32Rect(0, 0, expectedWidth, expectedHeight), pixels, rowBytes, 0);

                stage = "verify_full_pixel_oracle";
                for (int y = 0; y < expectedHeight; y++)
                {
                    for (int x = 0; x < expectedWidth; x++)
                    {
                        int offset = checked((y * expectedWidth + x) * 4);
                        int expectedR = 32 + (int)((long)x * 80L / expectedWidth);
                        int expectedG = 96 + (int)((long)y * 80L / expectedHeight);
                        int expectedB = 48 + (int)((long)(x + y) * 80L / (expectedWidth + (long)expectedHeight));
                        int deltaB = Math.Abs(pixels[offset] - expectedB);
                        int deltaG = Math.Abs(pixels[offset + 1] - expectedG);
                        int deltaR = Math.Abs(pixels[offset + 2] - expectedR);
                        int deltaA = Math.Abs(pixels[offset + 3] - 255);
                        int max = Math.Max(Math.Max(deltaR, deltaG), Math.Max(deltaB, deltaA));
                        if (max > maxRgbChannelError) maxRgbChannelError = max;
                        totalRgbError += deltaR + deltaG + deltaB;
                        if (deltaA != 0) alphaMismatchCount++;
                        decodedPixels++;
                    }
                }

                int[,] points = new int[,] {
                    { 0, 0 }, { 1, 1 }, { 16, 16 }, { 511, 511 }, { 1024, 1024 },
                    { 1999, 1999 }, { 2000, 2000 }, { 3001, 2377 }, { 3999, 3999 }
                };
                for (int i = 0; i < points.GetLength(0); i++)
                {
                    int x = points[i, 0];
                    int y = points[i, 1];
                    int offset = checked((y * expectedWidth + x) * 4);
                    crossCheckPoints.Add(new Dictionary<string, object> {
                        { "x", x }, { "y", y },
                        { "rgba", new int[] { pixels[offset + 2], pixels[offset + 1], pixels[offset], pixels[offset + 3] } }
                    });
                }

                using (SHA256 sha = SHA256.Create())
                    outputSha256 = BitConverter.ToString(sha.ComputeHash(pixels)).Replace("-", "").ToLowerInvariant();
            }
            timer.Stop();
            decodeCopyAndScanMs = timer.Elapsed.TotalMilliseconds;
            if (decodedPixels != (long)expectedWidth * expectedHeight)
                throw new InvalidOperationException("decoded_pixel_count_mismatch:" + decodedPixels);
            double meanRgbAbsoluteError = (double)totalRgbError / (decodedPixels * 3L);
            if (alphaMismatchCount != 0 || maxRgbChannelError > 24 || meanRgbAbsoluteError > 3.0)
                throw new InvalidOperationException("synthetic_pixel_oracle_failed:max=" + maxRgbChannelError + ":mean=" + meanRgbAbsoluteError.ToString("F6", System.Globalization.CultureInfo.InvariantCulture) + ":alphaMismatch=" + alphaMismatchCount);
        }
        catch (Exception ex)
        {
            failure = ex.GetType().FullName + ":" + ex.Message;
        }
        finally
        {
            stopSampling.Set();
            if (sampler != null) sampler.Join(2000);
            sampledPeakPrivate = Interlocked.Read(ref sampledPrivate);
            sampledPeakWorkingSet = Interlocked.Read(ref sampledWorking);
            pixels = null;
            encoded = null;
            using (Process current = Process.GetCurrentProcess())
            {
                current.Refresh();
                workingSetAfter = current.WorkingSet64;
                privateBytesAfter = current.PrivateMemorySize64;
                peakWorkingSet = current.PeakWorkingSet64;
                peakPagedMemory = current.PeakPagedMemorySize64;
            }
            stopSampling.Dispose();
        }

        result["result"] = failure == null ? "PASS" : "FAILED";
        result["failureStage"] = failure == null ? null : stage;
        result["failure"] = failure;
        result["processId"] = Process.GetCurrentProcess().Id;
        result["processArchitecture"] = Environment.Is64BitProcess ? "x64" : "x86";
        result["threadApartment"] = Thread.CurrentThread.GetApartmentState().ToString();
        result["powershellClrFramework"] = Environment.Version.ToString();
        result["decoder"] = "System.Windows.Media.Imaging.JpegBitmapDecoder (WPF managed imaging over Windows imaging infrastructure)";
        result["cacheOption"] = "BitmapCacheOption.None; memory stream remains open through CopyPixels";
        result["pixelFormat"] = "PixelFormats.Bgra32";
        result["frameCount"] = frameCount;
        result["width"] = actualWidth;
        result["height"] = actualHeight;
        result["decodedPixelCount"] = decodedPixels;
        result["inputBytes"] = File.Exists(imagePath) ? new FileInfo(imagePath).Length : 0L;
        result["inputSha256"] = inputSha256;
        result["outputBgraSha256"] = outputSha256;
        result["decodeCopyAndFullScanMs"] = decodeCopyAndScanMs;
        result["maxRgbChannelAbsoluteError"] = maxRgbChannelError;
        result["meanRgbAbsoluteError"] = decodedPixels == 0 ? null : (object)((double)totalRgbError / (decodedPixels * 3L));
        result["alphaMismatchCount"] = alphaMismatchCount;
        result["crossCheckPoints"] = crossCheckPoints;
        result["workingSetBeforeBytes"] = workingSetBefore;
        result["privateBytesBefore"] = privateBytesBefore;
        result["workingSetAfterBytes"] = workingSetAfter;
        result["privateBytesAfter"] = privateBytesAfter;
        result["peakWorkingSetBytes"] = peakWorkingSet;
        result["peakPagedMemoryBytes"] = peakPagedMemory;
        result["sampledPeakPrivateBytes"] = sampledPeakPrivate;
        result["sampledPeakWorkingSetBytes"] = sampledPeakWorkingSet;
        return result;
    }

    private static void UpdateMaximum(ref long target, long candidate)
    {
        long current;
        do
        {
            current = Interlocked.Read(ref target);
            if (candidate <= current) return;
        }
        while (Interlocked.CompareExchange(ref target, candidate, current) != current);
    }
}
'@

$childResult = $null
try {
  $presentationCore = [Reflection.Assembly]::LoadWithPartialName('PresentationCore')
  $windowsBase = [Reflection.Assembly]::LoadWithPartialName('WindowsBase')
  $systemXaml = [Reflection.Assembly]::LoadWithPartialName('System.Xaml')
  if (-not $presentationCore -or -not $windowsBase -or -not $systemXaml) { throw 'wpf_imaging_assemblies_unavailable' }
  Add-Type -TypeDefinition $probeSource -Language CSharp -ReferencedAssemblies @($presentationCore.Location, $windowsBase.Location, $systemXaml.Location)
  $childResult = [ClipNestT04WicJpegProbe]::Run($ImagePath, $ExpectedWidth, $ExpectedHeight)
  } catch {
    $childResult = @{
      result = 'FAILED'
    failureStage = 'compile_or_invoke_probe'
    failure = $_.Exception.GetType().FullName + ':' + $_.Exception.Message
    processId = $PID
    processArchitecture = if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' }
    threadApartment = [Threading.Thread]::CurrentThread.GetApartmentState().ToString()
      powershellClrFramework = [Environment]::Version.ToString()
    }
  }
  $childResult['windowsPowerShellVersion'] = $PSVersionTable.PSVersion.ToString()
  $childResult['clrFramework'] = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
  $childResult | ConvertTo-Json -Compress -Depth 8
if ($childResult.result -ne 'PASS') { exit 1 }
