param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$CoordinateJson
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$coordinates = ConvertFrom-Json -InputObject $CoordinateJson
$image = [System.Drawing.Image]::FromFile($ImagePath)
try {
  if ($image.Width -ne 4000 -or $image.Height -ne 4000) {
    throw "unexpected_dimensions:$($image.Width)x$($image.Height)"
  }
  $bitmap = [System.Drawing.Bitmap]::new($image)
  try {
    $samples = @(
      foreach ($point in $coordinates) {
        $color = $bitmap.GetPixel([int]$point.x, [int]$point.y)
        [pscustomobject]@{
          x = [int]$point.x
          y = [int]$point.y
          rgba = @([int]$color.R, [int]$color.G, [int]$color.B, 255)
        }
      }
    )
    [pscustomobject]@{
      decoder = 'Windows System.Drawing / GDI+ independent JPEG decode'
      powershellVersion = $PSVersionTable.PSVersion.ToString()
      dotNetRuntime = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
      width = $bitmap.Width
      height = $bitmap.Height
      pixelFormat = [string]$bitmap.PixelFormat
      samples = $samples
    } | ConvertTo-Json -Depth 6 -Compress
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $image.Dispose()
}
