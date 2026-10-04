param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$fixtureSource = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class ClipNestT04JpegFixture
{
    public static void Create(string outputPath, int width, int height)
    {
        if ((long)width * height != 16000000L) throw new InvalidOperationException("fixture_requires_16mp");
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            var rect = new Rectangle(0, 0, width, height);
            BitmapData data = bitmap.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                int rowBytes = checked(width * 4);
                byte[] row = new byte[rowBytes];
                for (int y = 0; y < height; y++)
                {
                    for (int x = 0; x < width; x++)
                    {
                        int offset = x * 4;
                        row[offset] = (byte)(48 + (long)(x + y) * 80L / (width + (long)height));
                        row[offset + 1] = (byte)(96 + ((long)y * 80L / height));
                        row[offset + 2] = (byte)(32 + ((long)x * 80L / width));
                        row[offset + 3] = 255;
                    }
                    Marshal.Copy(row, 0, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), rowBytes);
                }
            }
            finally { bitmap.UnlockBits(data); }

            ImageCodecInfo jpegCodec = null;
            foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
                if (String.Equals(codec.MimeType, "image/jpeg", StringComparison.OrdinalIgnoreCase)) jpegCodec = codec;
            if (jpegCodec == null) throw new InvalidOperationException("system_jpeg_encoder_not_found");

            using (var parameters = new EncoderParameters(1))
            using (var quality = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 96L))
            {
                parameters.Param[0] = quality;
                bitmap.Save(outputPath, jpegCodec, parameters);
            }
        }
        if (!File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
            throw new InvalidOperationException("system_jpeg_fixture_not_written");
    }
}
'@

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition $fixtureSource -Language CSharp -ReferencedAssemblies System.Drawing
  [ClipNestT04JpegFixture]::Create($OutputPath, $Width, $Height)
  [Console]::Out.WriteLine('{"result":"PASS","generator":"System.Drawing JPEG encoder"}')
} catch {
  [Console]::Error.WriteLine($_.Exception.GetType().FullName + ':' + $_.Exception.Message)
  exit 1
}
