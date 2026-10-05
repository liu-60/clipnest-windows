param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$RoiWidth,
  [Parameter(Mandatory = $true)][int]$RoiHeight
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
  throw 'wic_roi_oracle_requires_sta'
}
if ($RoiWidth -lt 1 -or $RoiHeight -lt 1 -or ([long]$RoiWidth * $RoiHeight) -gt 1024) {
  throw 'wic_roi_oracle_requires_1_to_1024_pixels'
}

[Reflection.Assembly]::LoadWithPartialName('PresentationCore') | Out-Null
[Reflection.Assembly]::LoadWithPartialName('WindowsBase') | Out-Null

$fullPath = [IO.Path]::GetFullPath($ImagePath)
$encoded = [IO.File]::ReadAllBytes($fullPath)
if ($encoded.Length -gt 20MB) { throw 'wic_roi_oracle_source_exceeds_20mib' }
$sha = [Security.Cryptography.SHA256]::Create()
$inputSha256 = ([BitConverter]::ToString($sha.ComputeHash($encoded))).Replace('-', '').ToLowerInvariant()
$stream = [IO.MemoryStream]::new($encoded, $false)
try {
  $decoder = [Windows.Media.Imaging.JpegBitmapDecoder]::new(
    $stream,
    [Windows.Media.Imaging.BitmapCreateOptions]::None,
    [Windows.Media.Imaging.BitmapCacheOption]::None
  )
  if ($decoder.Frames.Count -ne 1) { throw "wic_roi_oracle_frame_count_mismatch:$($decoder.Frames.Count)" }
  $frame = $decoder.Frames[0]
  if ($frame.PixelWidth -ne 4000 -or $frame.PixelHeight -ne 4000) {
    throw "wic_roi_oracle_dimensions_mismatch:$($frame.PixelWidth)x$($frame.PixelHeight)"
  }
  if ($X -lt 0 -or $Y -lt 0 -or ($X + $RoiWidth) -gt $frame.PixelWidth -or ($Y + $RoiHeight) -gt $frame.PixelHeight) {
    throw 'wic_roi_oracle_region_out_of_bounds'
  }

  $converted = [Windows.Media.Imaging.FormatConvertedBitmap]::new(
    $frame,
    [Windows.Media.PixelFormats]::Bgra32,
    $null,
    0
  )
  $rowBytes = $RoiWidth * 4
  $roiBytes = New-Object byte[] ($rowBytes * $RoiHeight)
  $rect = [Windows.Int32Rect]::new($X, $Y, $RoiWidth, $RoiHeight)
  $converted.CopyPixels($rect, $roiBytes, $rowBytes, 0)

  $samples = @(
    for ($row = 0; $row -lt $RoiHeight; $row++) {
      for ($column = 0; $column -lt $RoiWidth; $column++) {
        $offset = (($row * $RoiWidth) + $column) * 4
        [pscustomobject]@{
          x = $X + $column
          y = $Y + $row
          rgba = @([int]$roiBytes[$offset + 2], [int]$roiBytes[$offset + 1], [int]$roiBytes[$offset], [int]$roiBytes[$offset + 3])
        }
      }
    }
  )
  $roiSha256 = ([BitConverter]::ToString($sha.ComputeHash($roiBytes))).Replace('-', '').ToLowerInvariant()
  [pscustomobject]@{
    status = 'DECODED_SAMPLED_ONLY'
    decoder = 'System.Windows.Media.Imaging.JpegBitmapDecoder via WPF managed imaging / Windows imaging infrastructure'
    inputSha256 = $inputSha256
    width = $frame.PixelWidth
    height = $frame.PixelHeight
    pixelFormat = 'Bgra32'
    oracleStatus = 'NOT_EVALUATED_AGAINST_SOURCE_PIXEL_GROUND_TRUTH'
    roi = [pscustomobject]@{ x = $X; y = $Y; width = $RoiWidth; height = $RoiHeight }
    comparedPixelCount = $samples.Count
    roiBgraSha256 = $roiSha256
    samples = $samples
  } | ConvertTo-Json -Depth 6 -Compress
} finally {
  $stream.Dispose()
  $sha.Dispose()
}
