# Inertia CAD Bridge for AutoCAD (Windows, full AutoCAD).
#
# Inertia runs this script with Windows PowerShell 5.1 once per request: one
# JSON request on stdin, one JSON response on stdout. It attaches to the running
# AutoCAD over COM, so nothing has to be installed or trusted inside AutoCAD.
# Reads never change the drawing. Edits are re-validated against the preview's
# fingerprints and grouped in one Undo mark. There is deliberately no way to
# send AutoCAD commands, LISP or scripts through this bridge.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$BridgeVersion = '1.0.0'
$Protocol = 1
$DefaultLimit = 100
$MaxLimit = 500
$MaxScan = 5000
$MaxOperations = 50
$MaxTargets = 500
$MaxPlanTargets = 2000
# Objects of a block definition read into an erase fingerprint; each costs a few COM calls.
$MaxBlockDigestObjects = 500
$MaxCoordinate = 1e12
$MaxVertices = 200
$MaxLayers = 1000
$MaxBlocks = 500
$MaxStyles = 100
$MaxLayouts = 100
# The server kills the bridge at its deadline (60 s for reads), so work stops well before it.
$DefaultWorkMs = 35000
$DeadlineMarginMs = 15000
$StaleSetSeconds = 600
$ApplyMutexName = 'Local\InertiaCadApply'
$ReadMethods = @('selection', 'query', 'capture', 'info')
$Clock = [System.Diagnostics.Stopwatch]::StartNew()
$StartedUtc = [DateTime]::UtcNow
$WorkUntilMs = $DefaultWorkMs

$InsUnits = @{
  0 = 'unitless'; 1 = 'in'; 2 = 'ft'; 3 = 'mi'; 4 = 'mm'; 5 = 'cm'; 6 = 'm'; 7 = 'km'; 8 = 'microinch'; 9 = 'mil'; 10 = 'yd'; 11 = 'angstrom'; 12 = 'nm'
  13 = 'micron'; 14 = 'dm'; 15 = 'dam'; 16 = 'hm'; 17 = 'Gm'; 18 = 'au'; 19 = 'ly'; 20 = 'pc'; 21 = 'us-ft'; 22 = 'us-in'; 23 = 'us-yd'; 24 = 'us-mi'
}
$ShortTypes = @{
  AcDbLine = 'LINE'; AcDbPolyline = 'LWPOLYLINE'; AcDb2dPolyline = 'POLYLINE'; AcDb3dPolyline = 'POLYLINE'
  AcDbCircle = 'CIRCLE'; AcDbArc = 'ARC'; AcDbEllipse = 'ELLIPSE'; AcDbSpline = 'SPLINE'; AcDbPoint = 'POINT'
  AcDbText = 'TEXT'; AcDbMText = 'MTEXT'; AcDbBlockReference = 'INSERT'; AcDbMInsertBlock = 'INSERT'
  AcDbHatch = 'HATCH'; AcDbLeader = 'LEADER'; AcDbMLeader = 'MULTILEADER'; AcDbRasterImage = 'IMAGE'
  AcDbViewport = 'VIEWPORT'; AcDbAttributeDefinition = 'ATTDEF'; AcDbXline = 'XLINE'; AcDbRay = 'RAY'
  AcDbTable = 'ACAD_TABLE'; AcDbWipeout = 'WIPEOUT'; AcDbSolid = 'SOLID'; AcDb3dSolid = '3DSOLID'
  AcDbRegion = 'REGION'; AcDbFace = '3DFACE'
}
$TextAlignments = @('left', 'center', 'right', 'aligned', 'middle', 'fit', 'top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right')
$MTextAttachments = @($null, 'top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right')

# --- Errors -------------------------------------------------------------

function Fail([string]$Code, [string]$Message) {
  $exception = New-Object System.Exception $Message
  $exception.Data['inertia'] = $Code
  throw $exception
}

function Get-ErrorShape($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($null -ne $exception.InnerException -and $null -eq $exception.Data['inertia']) {
    if ($exception -is [System.Runtime.InteropServices.COMException]) { break }
    $exception = $exception.InnerException
  }
  if ($null -ne $exception.Data['inertia']) {
    return [ordered]@{ code = [string]$exception.Data['inertia']; message = $exception.Message }
  }
  $hresult = $exception.HResult
  switch ($hresult) {
    -2147221021 { return [ordered]@{ code = 'HOST_OFFLINE'; message = 'AutoCAD is not running. Open AutoCAD and the drawing, then try again.' } }
    -2147221005 { return [ordered]@{ code = 'NOT_INSTALLED'; message = 'Full AutoCAD for Windows is not installed. AutoCAD LT has no automation interface.' } }
    -2147418111 { return [ordered]@{ code = 'HOST_BUSY'; message = 'AutoCAD is busy (a command or dialog is open). Finish it and try again.' } }
    -2147417846 { return [ordered]@{ code = 'HOST_BUSY'; message = 'AutoCAD is busy (a command or dialog is open). Finish it and try again.' } }
  }
  $text = $exception.Message
  if ($text.Length -gt 500) { $text = $text.Substring(0, 500) }
  return [ordered]@{ code = 'HOST_ERROR'; message = $text }
}

# --- Windows interop ----------------------------------------------------

$InteropSource = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace InertiaCad {
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("00000016-0000-0000-C000-000000000046")]
  public interface IOleMessageFilter {
    [PreserveSig] int HandleInComingCall(int callType, IntPtr caller, int tickCount, IntPtr interfaceInfo);
    [PreserveSig] int RetryRejectedCall(IntPtr callee, int tickCount, int rejectType);
    [PreserveSig] int MessagePending(IntPtr callee, int tickCount, int pendingType);
  }

  // AutoCAD rejects COM calls while it is busy; retry for a while instead of failing at once.
  public class MessageFilter : IOleMessageFilter {
    [DllImport("ole32.dll")]
    private static extern int CoRegisterMessageFilter(IOleMessageFilter filter, out IOleMessageFilter previous);
    public static void Register() { IOleMessageFilter previous; CoRegisterMessageFilter(new MessageFilter(), out previous); }
    public static void Revoke() { IOleMessageFilter previous; CoRegisterMessageFilter(null, out previous); }
    int IOleMessageFilter.HandleInComingCall(int callType, IntPtr caller, int tickCount, IntPtr interfaceInfo) { return 0; }
    int IOleMessageFilter.RetryRejectedCall(IntPtr callee, int tickCount, int rejectType) {
      return (rejectType == 1 || rejectType == 2) && tickCount < 15000 ? 250 : -1;
    }
    int IOleMessageFilter.MessagePending(IntPtr callee, int tickCount, int pendingType) { return 2; }
  }

  [ComImport, Guid("00020400-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
  public interface IDispatchObject { }

  public static class Com {
    // AcadHatch.AppendOuterLoop refuses an array of VARIANTs (what PowerShell sends); it needs VT_ARRAY | VT_DISPATCH.
    public static void AppendOuterLoop(object hatch, object[] items) {
      IDispatchObject[] loop = new IDispatchObject[items.Length];
      for (int i = 0; i < items.Length; i++) loop[i] = (IDispatchObject)items[i];
      hatch.GetType().InvokeMember("AppendOuterLoop", System.Reflection.BindingFlags.InvokeMethod, null, hatch, new object[] { loop });
    }
  }

  public static class Window {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr handle, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public static Bitmap Capture(IntPtr handle) {
      Rect rect;
      if (!GetWindowRect(handle, out rect)) return null;
      int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
      if (width <= 0 || height <= 0) return null;
      Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        IntPtr hdc = graphics.GetHdc();
        bool printed = PrintWindow(handle, hdc, 2);
        graphics.ReleaseHdc(hdc);
        if (!printed) { bitmap.Dispose(); return null; }
      }
      return bitmap;
    }
  }
}
'@

function Get-InteropPath([string]$Source) {
  $base = $env:LOCALAPPDATA
  if ([string]::IsNullOrEmpty($base)) { $base = [System.IO.Path]::GetTempPath() }
  return Join-Path (Join-Path $base 'InertiaCad') ("interop-$(Get-Hash $Source).dll")
}

function Initialize-Interop {
  if ($null -ne ('InertiaCad.MessageFilter' -as [type])) { return }
  $dll = Get-InteropPath $InteropSource
  $folder = Split-Path -Parent $dll
  if (Test-Path -LiteralPath $dll) {
    try { Add-Type -Path $dll; return } catch { Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue }
  }
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  try {
    Add-Type -TypeDefinition $InteropSource -ReferencedAssemblies System.Drawing -OutputAssembly $dll -OutputType Library
    Add-Type -Path $dll
  } catch {
    Add-Type -TypeDefinition $InteropSource -ReferencedAssemblies System.Drawing
  }
}

function Connect-AutoCAD {
  [InertiaCad.MessageFilter]::Register()
  return [System.Runtime.InteropServices.Marshal]::GetActiveObject('AutoCAD.Application')
}

function Enter-ApplyLock {
  $mutex = New-Object System.Threading.Mutex($false, $ApplyMutexName)
  $owned = $false
  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) {
    $mutex.Dispose()
    Fail 'HOST_BUSY' 'Another Inertia edit is running in AutoCAD. Try again when it is done.'
  }
  return $mutex
}

function Exit-ApplyLock($Mutex) {
  try { $Mutex.ReleaseMutex() } catch { }
  $Mutex.Dispose()
}

function Test-ApplyRunning {
  try {
    $mutex = Enter-ApplyLock
    Exit-ApplyLock $mutex
    return $false
  } catch { return $true }
}

# --- Time ---------------------------------------------------------------

function ConvertTo-UtcTime($Value) {
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
  $text = [string]$Value
  $number = 0.0
  if ($text -match '^\d+(\.\d+)?$' -and [double]::TryParse($text, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$number).UtcDateTime
  }
  $parsed = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse($text, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) { return $parsed.UtcDateTime }
  Fail 'INVALID_REQUEST' 'deadlineAt must be an ISO time or epoch milliseconds.'
}

# Deadlines count from when this process started; without one, work keeps the default budget.
function Set-Deadline($Request, $Params, [System.Diagnostics.Stopwatch]$Clock, [DateTime]$StartedUtc) {
  $script:Clock = $Clock
  $deadlineMs = $null
  $at = $Request.deadlineAt
  if ($null -eq $at) { $at = $Params.deadlineAt }
  $ms = $Request.deadlineMs
  if ($null -eq $ms) { $ms = $Params.deadlineMs }
  if ($null -ne $at) { $deadlineMs = ((ConvertTo-UtcTime $at) - $StartedUtc).TotalMilliseconds }
  elseif ($null -ne $ms) { $deadlineMs = [double]$ms }
  $script:WorkUntilMs = $(if ($null -ne $deadlineMs) { $deadlineMs - $DeadlineMarginMs } else { $DefaultWorkMs })
}

function Test-OutOfTime { return $script:Clock.ElapsedMilliseconds -ge $script:WorkUntilMs }

# --- Small helpers ------------------------------------------------------

function Get-Rounded($Value, [int]$Digits = 4) {
  if ($null -eq $Value) { return $null }
  # Adding zero turns -0 into 0, which PowerShell 7 would print as -0.
  return [Math]::Round([double]$Value, $Digits) + 0.0
}

function Get-Degrees($Radians) {
  if ($null -eq $Radians) { return $null }
  return Get-Rounded ([double]$Radians * 180 / [Math]::PI) 3
}

# AutoCAD keeps rotations in [0, 2pi), so previews show what the drawing will read back.
function Get-RotationDeg([double]$Radians) {
  $degrees = Get-Degrees ((($Radians % (2 * [Math]::PI)) + 2 * [Math]::PI) % (2 * [Math]::PI))
  if ($degrees -ge 360) { return 0.0 }
  return $degrees
}

function Get-Point($Point) {
  if ($null -eq $Point) { return $null }
  return , @((Get-Rounded $Point[0]), (Get-Rounded $Point[1]), (Get-Rounded $Point[2]))
}

function Limit-Text($Text, [int]$Max = 500) {
  if ($null -eq $Text) { return $null }
  $value = [string]$Text
  if ($value.Length -gt $Max) { return $value.Substring(0, $Max) + '...' }
  return $value
}

function Get-Limit($Params) {
  $limit = 0
  if ($null -ne $Params.limit) { $limit = [int]$Params.limit }
  if ($limit -le 0) { $limit = $DefaultLimit }
  return [Math]::Min($limit, $MaxLimit)
}

function Get-ShortType([string]$ObjectName) {
  if ($ShortTypes.ContainsKey($ObjectName)) { return $ShortTypes[$ObjectName] }
  if ($ObjectName -like 'AcDb*Dimension*') { return 'DIMENSION' }
  return $ObjectName
}

function Get-Hash([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').Substring(0, 16).ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-Coordinate($Value, [string]$Name) {
  $items = @($Value)
  if ($items.Count -lt 2 -or $items.Count -gt 3) { Fail 'INVALID_REQUEST' "$Name must be [x, y] or [x, y, z] in drawing units." }
  $result = New-Object 'double[]' 3
  for ($i = 0; $i -lt $items.Count; $i++) {
    $number = 0.0
    if (-not [double]::TryParse([string]$items[$i], [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number) -or
      -not ([Math]::Abs($number) -le $MaxCoordinate)) {
      Fail 'INVALID_REQUEST' "$Name is out of range: each value must be a number within $MaxCoordinate drawing units of the origin."
    }
    $result[$i] = $number
  }
  return , $result
}

function Get-Number($Value, [string]$Name, [string]$Unit = 'number') {
  $number = 0.0
  if ($null -eq $Value -or -not [double]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number) -or
    [double]::IsNaN($number) -or [double]::IsInfinity($number)) {
    Fail 'INVALID_REQUEST' "$Name must be a finite $Unit."
  }
  return $number
}

function Get-Radians($Value, [string]$Name) {
  return (Get-Number $Value $Name 'number of degrees') * [Math]::PI / 180
}

$MTextCodes = [regex]'\\(?:U\+([0-9A-Fa-f]{4})|S([^;]*);|([\\{}])|[PN~]|[fFHCcATQWp][^;]*;|[LlOoKk])|[{}]'

function Get-PlainText([string]$Text) {
  return $MTextCodes.Replace($Text, {
      param($Match)
      if ($Match.Groups[1].Success) { return [string][char][Convert]::ToInt32($Match.Groups[1].Value, 16) }
      if ($Match.Groups[2].Success) { return $Match.Groups[2].Value -replace '[\^#]', '/' }
      if ($Match.Groups[3].Success) { return $Match.Groups[3].Value }
      if ($Match.Value -cmatch '^\\[PN~]$') { return ' ' }
      return ''
    })
}

function Get-Vertices($Coordinates, [int]$Stride, [int]$Keep) {
  $vertices = New-Object System.Collections.ArrayList
  for ($i = 0; $i + $Stride -le $Coordinates.Count -and $vertices.Count -lt $MaxVertices; $i += $Stride) {
    [void]$vertices.Add(@(for ($j = 0; $j -lt $Keep; $j++) { Get-Rounded $Coordinates[$i + $j] }))
  }
  return , $vertices.ToArray()
}

function Get-Extent($Entity) {
  $min = $null
  $max = $null
  try { $Entity.GetBoundingBox([ref]$min, [ref]$max) } catch { return $null }
  if ($null -eq $min -or $null -eq $max) { return $null }
  return @{ min = $min; max = $max }
}

# DBMOD 8 (window) and 16 (view) flip on every zoom or pan, which leaves the file on disk current.
function Test-UnsavedChanges($Doc) {
  try { return ([int]$Doc.GetVariable('DBMOD') -band -bnot 24) -ne 0 } catch { return -not [bool]$Doc.Saved }
}

function Get-UnitsName($Doc) {
  try { return $InsUnits[[int]$Doc.GetVariable('INSUNITS')] } catch { return $null }
}

# --- Documents ----------------------------------------------------------

function Get-DocumentId($Doc) {
  $full = [string]$Doc.FullName
  if ([string]::IsNullOrEmpty($full)) { return 'acad:' + [string]$Doc.Name }
  return 'acad:' + $full
}

function Get-ActiveDocumentId($Acad) {
  try { return Get-DocumentId $Acad.ActiveDocument } catch { return $null }
}

function Get-Documents($Acad, $Params) {
  $active = Get-ActiveDocumentId $Acad
  $list = New-Object System.Collections.ArrayList
  foreach ($doc in $Acad.Documents) {
    $id = Get-DocumentId $doc
    $full = [string]$doc.FullName
    [void]$list.Add([ordered]@{
        documentId   = $id
        app          = 'autocad'
        name         = [string]$doc.Name
        path         = $(if ([string]::IsNullOrEmpty($full)) { $null } else { $full })
        modified     = Test-UnsavedChanges $doc
        active       = ($id -eq $active)
        readOnly     = [bool]$doc.ReadOnly
        displayUnits = Get-UnitsName $doc
        activeLayout = $(try { [string]$doc.ActiveLayout.Name } catch { $null })
      })
  }
  return [ordered]@{ documents = $list.ToArray() }
}

function Resolve-Document($Acad, [string]$DocumentId, [switch]$RequireActive) {
  foreach ($doc in $Acad.Documents) {
    if ((Get-DocumentId $doc) -eq $DocumentId) {
      if ($RequireActive -and $DocumentId -ne (Get-ActiveDocumentId $Acad)) {
        Fail 'INACTIVE_DOCUMENT' 'Switch AutoCAD to this drawing''s tab, then try again.'
      }
      return $doc
    }
  }
  Fail 'DOCUMENT_NOT_FOUND' 'That drawing is no longer open in AutoCAD. Call inertia_cad_status for current documents.'
}

function Get-LayoutMap($Doc) {
  $map = @{}
  foreach ($layout in $Doc.Layouts) {
    $map[[string]$layout.Block.ObjectID] = [string]$layout.Name
  }
  return $map
}

function Get-ModifiedState($Doc) {
  $state = @{ dbmod = $null; count = $null }
  try { $state.dbmod = [int]$Doc.GetVariable('DBMOD') } catch { }
  try { $state.count = [int]$Doc.ModelSpace.Count } catch { }
  return $state
}

# Reads must never change the drawing; if one did, stop before anything can save it.
function Invoke-Read($Acad, $Params, [string]$Command) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId)
  $applying = Test-ApplyRunning
  $before = Get-ModifiedState $doc
  $concurrent = $false
  try {
    $result = & $Command $Acad $Params
  } finally {
    $after = Get-ModifiedState $doc
    if (($null -ne $before.dbmod -and -not ($before.dbmod -band 1) -and ($after.dbmod -band 1)) -or
      ($null -ne $before.count -and $null -ne $after.count -and $after.count -lt $before.count)) {
      $concurrent = $applying -or (Test-ApplyRunning)
      if (-not $concurrent) {
        Fail 'READ_MODIFIED_DRAWING' 'The drawing changed while Inertia was only reading it. Do not save it and do not undo anything yet: tell the designer, who may have been editing at the same time, and let them decide whether to undo.'
      }
    }
  }
  if ($concurrent) { $result.concurrentEdit = $true }
  return $result
}

# --- Entities -----------------------------------------------------------

function Get-BoxRow($Extent) {
  if ($null -eq $Extent) { return $null }
  return , @(@((Get-Rounded $Extent.min[0]), (Get-Rounded $Extent.min[1])), @((Get-Rounded $Extent.max[0]), (Get-Rounded $Extent.max[1])))
}

# One property per try, so a row keeps what it could read when one property fails.
function Add-Field($Row, [string]$Field, [scriptblock]$Read) {
  try {
    $value = & $Read
    if ($null -ne $value) { $Row[$Field] = $value }
  } catch { $Row.partial = $true }
}

# Polyline and old-style POLYLINE coordinates are in the object's coordinate system.
function Add-Plane($Row, $Entity) {
  $Row.elevation = Get-Rounded $Entity.Elevation
  $normal = Get-Point $Entity.Normal
  if ($null -ne $normal -and ($normal[0] -ne 0 -or $normal[1] -ne 0 -or $normal[2] -ne 1)) { $Row.normal = $normal }
}

function Get-ChordLength($Coordinates, [bool]$Closed) {
  $sum = 0.0
  $count = [int]($Coordinates.Count / 2)
  if ($count -lt 2) { return 0.0 }
  $last = $(if ($Closed) { $count } else { $count - 1 })
  for ($i = 0; $i -lt $last; $i++) {
    $j = ($i + 1) % $count
    $sum += [Math]::Sqrt([Math]::Pow($Coordinates[2 * $j] - $Coordinates[2 * $i], 2) + [Math]::Pow($Coordinates[2 * $j + 1] - $Coordinates[2 * $i + 1], 2))
  }
  return $sum
}

function Get-EntityRow($Entity, $LayoutMap, $Options = @{}, $Extent = $null) {
  $objectName = [string]$Entity.ObjectName
  $row = [ordered]@{ handle = [string]$Entity.Handle; type = (Get-ShortType $objectName); layer = [string]$Entity.Layer }
  if ($Options.bbox) {
    if ($null -eq $Extent) { $Extent = Get-Extent $Entity }
    $row.bbox = Get-BoxRow $Extent
  }
  if ($Options.compact) { return $row }
  try { $row.color = [int]$Entity.Color } catch { }
  $owner = [string]$Entity.OwnerID
  if ($LayoutMap.ContainsKey($owner)) { $row.layout = $LayoutMap[$owner] } else { $row.nested = $true }
  try {
    switch -Wildcard ($objectName) {
      'AcDbLine' { $row.start = Get-Point $Entity.StartPoint; $row.end = Get-Point $Entity.EndPoint; $row.length = Get-Rounded $Entity.Length }
      'AcDbPolyline' {
        $row.closed = [bool]$Entity.Closed
        $length = [double]$Entity.Length
        $row.length = Get-Rounded $length
        $coordinates = @($Entity.Coordinates)
        $row.vertexCount = [int]($coordinates.Count / 2)
        $row.vertices = Get-Vertices $coordinates 2 2
        if ($row.vertexCount -gt $MaxVertices) { $row.verticesTruncated = $true }
        Add-Plane $row $Entity
        # Arc segments make the length exceed the sum of chords, so straight polylines skip GetBulge.
        if ([Math]::Abs($length - (Get-ChordLength $coordinates $row.closed)) -gt 1e-9 * [Math]::Max(1.0, $length)) {
          $bulges = @(for ($i = 0; $i -lt $row.vertices.Count; $i++) { Get-Rounded $Entity.GetBulge($i) 6 })
          if (@($bulges | Where-Object { $_ -ne 0 }).Count -gt 0) { $row.bulges = $bulges }
        }
        if ($row.closed) { $row.area = Get-Rounded $Entity.Area }
      }
      'AcDb[23]dPolyline' {
        $flat = $objectName -eq 'AcDb2dPolyline'
        $row.closed = [bool]$Entity.Closed
        $row.length = Get-Rounded $Entity.Length
        # Both kinds give three values per vertex; AutoCAD ignores a 2D polyline's Z (its elevation applies).
        $coordinates = @($Entity.Coordinates)
        $row.vertexCount = [int]($coordinates.Count / 3)
        $row.vertices = Get-Vertices $coordinates 3 $(if ($flat) { 2 } else { 3 })
        if ($row.vertexCount -gt $MaxVertices) { $row.verticesTruncated = $true }
        if ($flat) { Add-Plane $row $Entity }
      }
      'AcDbSpline' {
        $row.fitPointCount = [int]$Entity.NumberOfFitPoints
        $row.controlPointCount = [int]$Entity.NumberOfControlPoints
        $row.controlPoints = Get-Vertices @($Entity.ControlPoints) 3 3
        if ($row.controlPointCount -gt $MaxVertices) { $row.controlPointsTruncated = $true }
      }
      'AcDbEllipse' {
        $row.center = Get-Point $Entity.Center; $row.majorAxis = Get-Point $Entity.MajorAxis; $row.ratio = Get-Rounded $Entity.RadiusRatio 6
        $row.startParam = Get-Rounded $Entity.StartParameter 6; $row.endParam = Get-Rounded $Entity.EndParameter 6
      }
      'AcDbCircle' { $row.center = Get-Point $Entity.Center; $row.radius = Get-Rounded $Entity.Radius }
      'AcDbArc' {
        $row.center = Get-Point $Entity.Center; $row.radius = Get-Rounded $Entity.Radius
        $row.startAngleDeg = Get-Rounded ([double]$Entity.StartAngle * 180 / [Math]::PI) 3
        $row.endAngleDeg = Get-Rounded ([double]$Entity.EndAngle * 180 / [Math]::PI) 3
      }
      'AcDbText' {
        $row.text = Limit-Text $Entity.TextString; $row.position = Get-Point $Entity.InsertionPoint; $row.height = Get-Rounded $Entity.Height
        Add-Field $row 'style' { [string]$Entity.StyleName }
        Add-Field $row 'widthFactor' { Get-Rounded $Entity.ScaleFactor }
        Add-Field $row 'rotationDeg' { Get-Degrees $Entity.Rotation }
        Add-Field $row 'alignment' { $TextAlignments[[int]$Entity.Alignment] }
        # Only left-aligned text is anchored at its insertion point.
        if ($row.alignment -and $row.alignment -ne 'left') { Add-Field $row 'alignmentPoint' { Get-Point $Entity.TextAlignmentPoint } }
      }
      'AcDbMText' {
        $row.text = Limit-Text (Get-PlainText $Entity.TextString); $row.position = Get-Point $Entity.InsertionPoint; $row.height = Get-Rounded $Entity.Height
        Add-Field $row 'style' { [string]$Entity.StyleName }
        Add-Field $row 'width' { Get-Rounded $Entity.Width }
        Add-Field $row 'attachment' { $MTextAttachments[[int]$Entity.AttachmentPoint] }
      }
      'AcDbBlockReference' {
        $row.block = $(try { [string]$Entity.EffectiveName } catch { [string]$Entity.Name })
        $row.position = Get-Point $Entity.InsertionPoint
        $row.rotationDeg = Get-Rounded ([double]$Entity.Rotation * 180 / [Math]::PI) 3
        $row.scale = @((Get-Rounded $Entity.XScaleFactor), (Get-Rounded $Entity.YScaleFactor), (Get-Rounded $Entity.ZScaleFactor))
        if ([bool]$Entity.HasAttributes) {
          $attributes = New-Object System.Collections.ArrayList
          foreach ($attribute in @($Entity.GetAttributes())) {
            if ($attributes.Count -ge 30) { break }
            [void]$attributes.Add([ordered]@{ tag = [string]$attribute.TagString; value = Limit-Text $attribute.TextString 200 })
          }
          $row.attributes = $attributes.ToArray()
        }
      }
      'AcDb*Dimension*' {
        $row.measurement = Get-Rounded $Entity.Measurement
        $override = [string]$Entity.TextOverride
        if ($override) { $row.textOverride = Limit-Text $override 200 }
        Add-Field $row 'textPosition' { Get-Point $Entity.TextPosition }
        # AutoCAD's COM interface has no definition points for rotated, radial or diametric dimensions.
        switch ($objectName) {
          'AcDbRotatedDimension' { Add-Field $row 'rotationDeg' { Get-Degrees $Entity.Rotation } }
          { @('AcDbAlignedDimension', 'AcDbArcDimension') -contains $_ } {
            Add-Field $row 'extLine1Point' { Get-Point $Entity.ExtLine1Point }
            Add-Field $row 'extLine2Point' { Get-Point $Entity.ExtLine2Point }
          }
          'AcDbArcDimension' { Add-Field $row 'center' { Get-Point $Entity.CenterPoint } }
          'AcDb3PointAngularDimension' {
            Add-Field $row 'center' { Get-Point $Entity.AngleVertex }
            Add-Field $row 'extLine1Point' { Get-Point $Entity.ExtLine1EndPoint }
            Add-Field $row 'extLine2Point' { Get-Point $Entity.ExtLine2EndPoint }
          }
          'AcDb2LineAngularDimension' {
            Add-Field $row 'extLine1Start' { Get-Point $Entity.ExtLine1StartPoint }
            Add-Field $row 'extLine1End' { Get-Point $Entity.ExtLine1EndPoint }
            Add-Field $row 'extLine2Start' { Get-Point $Entity.ExtLine2StartPoint }
            Add-Field $row 'extLine2End' { Get-Point $Entity.ExtLine2EndPoint }
          }
          'AcDbRadialDimensionLarge' {
            Add-Field $row 'center' { Get-Point $Entity.Center }
            Add-Field $row 'chordPoint' { Get-Point $Entity.ChordPoint }
          }
        }
      }
      'AcDbHatch' { $row.pattern = [string]$Entity.PatternName; $row.area = Get-Rounded $Entity.Area }
    }
  } catch { $row.partial = $true }
  return $row
}

function Get-Fingerprint($Entity) {
  $parts = New-Object System.Collections.ArrayList
  foreach ($name in 'ObjectName', 'Handle', 'OwnerID', 'Layer', 'Color', 'StartPoint', 'EndPoint', 'Center', 'Radius', 'InsertionPoint', 'Rotation', 'XScaleFactor', 'YScaleFactor', 'ZScaleFactor', 'Normal', 'TextString', 'Coordinates', 'Closed') {
    $value = $null
    try { $value = $Entity.$name } catch { }
    if ($null -eq $value) { [void]$parts.Add('') } elseif ($value -is [System.Array]) { [void]$parts.Add((@($value) | ForEach-Object { Get-Rounded $_ 6 }) -join ',') } else { [void]$parts.Add([string]$value) }
  }
  try {
    if ([bool]$Entity.HasAttributes) {
      foreach ($attribute in @($Entity.GetAttributes())) { [void]$parts.Add([string]$attribute.TagString + '=' + [string]$attribute.TextString) }
    }
  } catch { }
  return Get-Hash ($parts -join '|')
}

# What erasing a block insert removes from view: its definition's own objects.
# An edit to the definition after the preview makes an erase proposal stale.
# Nested blocks count by their own insert properties, not their contents.
function Get-BlockDefinitionDigest($Doc, $Entity) {
  if ([string]$Entity.ObjectName -ne 'AcDbBlockReference') { return $null }
  try {
    $block = $Doc.Blocks.Item([string]$Entity.Name)
    $count = [int]$block.Count
    $parts = New-Object System.Collections.ArrayList
    [void]$parts.Add([string]$count)
    for ($i = 0; $i -lt [Math]::Min($count, $MaxBlockDigestObjects); $i++) { [void]$parts.Add((Get-Fingerprint $block.Item($i))) }
    return Get-Hash ($parts -join ';')
  } catch {
    return 'unreadable'
  }
}

function Get-Selection($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId)
  $limit = Get-Limit $Params
  $layoutMap = Get-LayoutMap $doc
  $set = $doc.PickfirstSelectionSet
  $count = [int]$set.Count
  $items = New-Object System.Collections.ArrayList
  $outOfTime = $false
  for ($i = 0; $i -lt [Math]::Min($count, $limit); $i++) {
    if ($items.Count -gt 0 -and (Test-OutOfTime)) { $outOfTime = $true; break }
    [void]$items.Add((Get-EntityRow $set.Item($i) $layoutMap))
  }
  $result = [ordered]@{
    documentId = Get-DocumentId $doc
    units      = Get-UnitsName $doc
    total      = $count
    truncated  = $count -gt $items.Count
    items      = $items.ToArray()
  }
  if ($outOfTime) { $result.partial = $true; $result.timeBudgetHit = $true }
  if ($count -eq 0) {
    if ((Get-DocumentId $doc) -ne (Get-ActiveDocumentId $Acad)) {
      $result.hint = 'This drawing is not the active tab in AutoCAD, and AutoCAD only reports the selection of the active drawing. Switch to its tab, select the objects, and ask again.'
    } elseif ($(try { [int]$doc.GetVariable('PICKFIRST') } catch { 1 }) -eq 0) {
      $result.hint = 'PICKFIRST is 0 in AutoCAD, so objects selected outside a command are not readable. Set PICKFIRST to 1, select the objects again, and ask again.'
    }
  }
  return $result
}

function Get-SetStamp { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function Select-Entities($Doc, [string[]]$Types, [string]$Layer, [string]$Layout, $Region) {
  $codes = New-Object 'System.Collections.Generic.List[int16]'
  $values = New-Object 'System.Collections.Generic.List[object]'
  if ($Types.Count -gt 0) { $codes.Add(0); $values.Add(($Types -join ',')) }
  if ($Layer) { $codes.Add(8); $values.Add($Layer) }
  if ($Layout -and $Layout -ne '*') { $codes.Add(410); $values.Add($Layout) }
  $missing = [System.Type]::Missing
  $mode = 5
  $point1 = $missing
  $point2 = $missing
  if ($null -ne $Region) {
    # Window and crossing pick from the view, so AutoCAD may skip off-screen objects or catch near ones; callers re-check bounding boxes.
    $mode = $(if ($Region.window) { 0 } else { 1 })
    $point1 = $Region.min
    $point2 = $Region.max
  }
  $name = 'INERTIACAD{0}_{1}' -f (Get-SetStamp), [guid]::NewGuid().ToString('N').Substring(0, 6)
  $set = $Doc.SelectionSets.Add($name)
  try {
    if ($codes.Count -gt 0) {
      $set.Select($mode, $point1, $point2, [int16[]]$codes.ToArray(), [object[]]$values.ToArray())
    } else {
      $set.Select($mode, $point1, $point2, $missing, $missing)
    }
  } catch {
    Remove-SelectionSet $set
    throw
  }
  # The comma keeps PowerShell from unrolling the set into its entities; Delete() on those erases them.
  return , $set
}

function Remove-SelectionSet($Set) {
  # Delete() on anything but our own selection set erases drawing objects.
  if ($null -eq $Set -or $Set -is [System.Array]) { return }
  $name = $null
  try { $name = [string]$Set.Name } catch { }
  if ($name -like 'INERTIACAD*') { try { $Set.Delete() } catch { } }
}

# A bridge killed on timeout never reaches its finally block, so earlier runs can leave sets behind.
function Remove-StaleSelectionSets($Doc) {
  $cutoff = (Get-SetStamp) - $StaleSetSeconds
  $stale = New-Object System.Collections.ArrayList
  $sets = $Doc.SelectionSets
  for ($i = 0; $i -lt [int]$sets.Count; $i++) {
    $set = $sets.Item($i)
    $name = [string]$set.Name
    if ($name -like 'INERTIACAD*' -and -not ($name -match '^INERTIACAD(\d+)_' -and [long]$Matches[1] -ge $cutoff)) { [void]$stale.Add($set) }
  }
  foreach ($set in $stale) { Remove-SelectionSet $set }
}

function Get-Region($Within, [string]$Name = 'within') {
  if ($null -eq $Within) { return $null }
  $a = Get-Coordinate $Within.min "$Name.min"
  $b = Get-Coordinate $Within.max "$Name.max"
  $mode = 'crossing'
  if ($Within.mode) { $mode = [string]$Within.mode }
  if (@('crossing', 'window') -notcontains $mode) { Fail 'INVALID_REQUEST' "$Name.mode must be crossing or window." }
  $min = New-Object 'double[]' 3
  $max = New-Object 'double[]' 3
  for ($i = 0; $i -lt 2; $i++) { $min[$i] = [Math]::Min($a[$i], $b[$i]); $max[$i] = [Math]::Max($a[$i], $b[$i]) }
  return @{ min = $min; max = $max; window = ($mode -eq 'window') }
}

function Test-Region($Extent, $Region) {
  if ($null -eq $Extent) { return $true }
  for ($i = 0; $i -lt 2; $i++) {
    if ($Region.window) {
      if ($Extent.min[$i] -lt $Region.min[$i] -or $Extent.max[$i] -gt $Region.max[$i]) { return $false }
    } elseif ($Extent.max[$i] -lt $Region.min[$i] -or $Extent.min[$i] -gt $Region.max[$i]) { return $false }
  }
  return $true
}

function Get-SearchText($Entity) {
  $text = ''
  try { $text = [string]$Entity.TextString } catch { }
  if ($text -match '[\\{]') { $text += ' ' + (Get-PlainText $text) }
  try { if ([bool]$Entity.HasAttributes) { foreach ($attribute in @($Entity.GetAttributes())) { $text += ' ' + [string]$attribute.TextString } } } catch { }
  try { $text += ' ' + [string]$Entity.EffectiveName } catch { }
  return $text.ToLowerInvariant()
}

function Find-Entities($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId)
  $limit = Get-Limit $Params
  $offset = 0
  if ($null -ne $Params.cursor) { $offset = [Math]::Max(0, [int]$Params.cursor) }
  $types = @($Params.types | Where-Object { $_ } | ForEach-Object { ([string]$_).ToUpperInvariant() })
  foreach ($type in $types) { if ($type -notmatch '^[A-Z0-9_*]+$') { Fail 'INVALID_REQUEST' "Unknown entity type $type. Use DXF names such as LINE, LWPOLYLINE, INSERT, TEXT, MTEXT." } }
  $layout = 'Model'
  if ($Params.layout) { $layout = [string]$Params.layout }
  $needle = $null
  if ($Params.textContains) { $needle = ([string]$Params.textContains).ToLowerInvariant() }
  if ($Params.fields -and @('compact', 'full') -notcontains [string]$Params.fields) { Fail 'INVALID_REQUEST' 'fields must be compact or full.' }
  $options = @{ compact = ($Params.fields -eq 'compact'); bbox = ($Params.bbox -eq $true) }
  $region = Get-Region $Params.within
  $layoutMap = Get-LayoutMap $doc
  Remove-StaleSelectionSets $doc
  $set = Select-Entities $doc $types ([string]$Params.layer) $layout $region
  try {
    $count = [int]$set.Count
    $items = New-Object System.Collections.ArrayList
    $total = $count
    $capped = $false
    $outOfTime = $false
    $filtered = $false
    if ($null -eq $needle -and $null -eq $region) {
      for ($i = $offset; $i -lt [Math]::Min($count, $offset + $limit); $i++) {
        if ($items.Count -gt 0 -and (Test-OutOfTime)) { $outOfTime = $true; break }
        [void]$items.Add((Get-EntityRow $set.Item($i) $layoutMap $options))
      }
    } else {
      # A text or region filter runs here, so the cursor is a scan position, not a match count:
      # each call resumes where the last stopped and scans at least one object, so paging always
      # progresses and a scan longer than one call's budget still reaches every match.
      $filtered = $true
      $positions = New-Object System.Collections.ArrayList
      $resume = $null
      $scanned = 0
      $i = $offset
      while ($i -lt $count) {
        if ($scanned -ge $MaxScan) { $capped = $true; $resume = $i; break }
        if ($scanned -gt 0 -and (Test-OutOfTime)) { $outOfTime = $true; $resume = $i; break }
        $entity = $set.Item($i)
        $i++
        $scanned++
        if ($null -ne $needle -and -not (Get-SearchText $entity).Contains($needle)) { continue }
        $extent = $null
        if ($null -ne $region) {
          $extent = Get-Extent $entity
          if (-not (Test-Region $extent $region)) { continue }
        }
        # A full page stops at the next match, which starts the next page.
        if ($items.Count -ge $limit) { $resume = $i - 1; break }
        [void]$items.Add((Get-EntityRow $entity $layoutMap $options $extent))
        [void]$positions.Add($i - 1)
      }
    }
    $result = [ordered]@{
      documentId = Get-DocumentId $doc
      units      = Get-UnitsName $doc
      layout     = $layout
      items      = $items.ToArray()
    }
    if ($filtered) {
      # Objects of the requested types and layer, before the text or region filter.
      $result.candidates = $count
      if ($null -ne $resume -and $resume -lt $count) { $result.nextCursor = [string]$resume }
      # Each row's scan position, so a caller that returns fewer rows can resume after the last one.
      $result.scanPositions = $positions.ToArray()
      if ($outOfTime) { $result.partial = $true; $result.timeBudgetHit = $true }
    } else {
      $result.total = $total
      if ($outOfTime) {
        $result.partial = $true
        $result.timeBudgetHit = $true
        if ($items.Count -gt 0) { $result.nextCursor = [string]($offset + $items.Count) }
      } elseif ($offset + $limit -lt $total) { $result.nextCursor = [string]($offset + $limit) }
    }
    if ($capped) { $result.scanCapped = $true }
    return $result
  } finally {
    Remove-SelectionSet $set
  }
}

function Get-CaptureRegion($Params) {
  if ($Params.extents -eq $true -and $null -ne $Params.bbox) { Fail 'INVALID_REQUEST' 'Pass extents or bbox, not both.' }
  if ($Params.extents -eq $true) { return @{ extents = $true } }
  $region = Get-Region $Params.bbox 'bbox'
  if ($null -ne $region -and ($region.min[0] -eq $region.max[0] -or $region.min[1] -eq $region.max[1])) { Fail 'INVALID_REQUEST' 'bbox needs a width and a height.' }
  return $region
}

function Get-ViewState($Doc) {
  return @{ center = @($Doc.GetVariable('VIEWCTR')); size = [double]$Doc.GetVariable('VIEWSIZE') }
}

function Test-SameView($A, $B) {
  $tolerance = 1e-6 * $A.size
  if ([Math]::Abs($A.size - $B.size) -gt $tolerance) { return $false }
  for ($i = 0; $i -lt 2; $i++) { if ([Math]::Abs($A.center[$i] - $B.center[$i]) -gt $tolerance) { return $false } }
  return $true
}

# ZoomExtents recomputes EXTMIN/EXTMAX, which marks the drawing's system variables as changed (DBMOD 4),
# so zoom to the stored extents with a window and fall back to ZoomExtents only when they are unusable.
function Get-ExtentsWindow($Doc) {
  try {
    $min = @($Doc.GetVariable('EXTMIN'))
    $max = @($Doc.GetVariable('EXTMAX'))
    $width = [double]$max[0] - [double]$min[0]
    $height = [double]$max[1] - [double]$min[1]
    if (-not ($width -gt 0 -and $height -gt 0)) { return $null }
    $margin = 0.02 * [Math]::Max($width, $height)
    return @{
      min = [double[]]@(([double]$min[0] - $margin), ([double]$min[1] - $margin), 0.0)
      max = [double[]]@(([double]$max[0] + $margin), ([double]$max[1] + $margin), 0.0)
    }
  } catch { return $null }
}

function Get-Capture($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId) -RequireActive
  $region = Get-CaptureRegion $Params
  [void][InertiaCad.Window]::SetProcessDPIAware()
  $handle = [IntPtr][long]$Acad.HWND
  if ([InertiaCad.Window]::IsIconic($handle)) { Fail 'CAPTURE_FAILED' 'AutoCAD is minimized. Restore its window and try again.' }
  $saved = $null
  $restored = $true
  try {
    if ($null -ne $region) {
      $saved = Get-ViewState $doc
      if ($region.extents) {
        $window = Get-ExtentsWindow $doc
        if ($null -eq $window) { $Acad.ZoomExtents() } else { $Acad.ZoomWindow($window.min, $window.max) }
      } else { $Acad.ZoomWindow($region.min, $region.max) }
      try { $Acad.Update() } catch { }
    }
    $bitmap = [InertiaCad.Window]::Capture($handle)
  } finally {
    # ZoomPrevious restores center, height, twist and direction from AutoCAD's own view history. It runs
    # only when the view really moved, so a zoom that changed nothing never pops the designer's earlier view.
    if ($null -ne $saved) {
      try {
        if (-not (Test-SameView $saved (Get-ViewState $doc))) { $Acad.ZoomPrevious() }
        $restored = Test-SameView $saved (Get-ViewState $doc)
      } catch { $restored = $false }
    }
  }
  if ($null -eq $bitmap) { Fail 'CAPTURE_FAILED' 'Windows could not capture the AutoCAD window.' }
  try {
    $maxWidth = [Math]::Min(2048, [Math]::Max(64, [int]$Params.maxWidth))
    $maxHeight = [Math]::Min(2048, [Math]::Max(64, [int]$Params.maxHeight))
    $scale = [Math]::Min(1.0, [Math]::Min($maxWidth / $bitmap.Width, $maxHeight / $bitmap.Height))
    $width = [Math]::Max(1, [int][Math]::Round($bitmap.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($bitmap.Height * $scale))
    $scaled = New-Object System.Drawing.Bitmap $bitmap, $width, $height
    $stream = New-Object System.IO.MemoryStream
    try {
      $scaled.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $data = [Convert]::ToBase64String($stream.ToArray())
    } finally { $scaled.Dispose(); $stream.Dispose() }
  } finally { $bitmap.Dispose() }
  $result = [ordered]@{
    documentId = Get-DocumentId $doc
    width      = $width
    height     = $height
    pngBase64  = $data
    scene      = $(try { [string]$doc.ActiveLayout.Name } catch { $null })
  }
  if (-not $restored) { $result.viewRestored = $false }
  return $result
}

# --- Edits --------------------------------------------------------------

function Get-Targets($Op) {
  $handles = @($Op.handles | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  if ($handles.Count -eq 0 -and $Op.handle) { $handles = @([string]$Op.handle) }
  if ($handles.Count -eq 0) { Fail 'INVALID_REQUEST' "$($Op.op) needs at least one handle." }
  if ($handles.Count -gt $MaxTargets) { Fail 'INVALID_REQUEST' "$($Op.op) accepts at most $MaxTargets handles." }
  return , $handles
}

function Test-LayerName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 255 -or $Name -match '[<>/\\":;?*|,=`]') {
    Fail 'INVALID_REQUEST' "Layer name `"$Name`" is not valid in AutoCAD."
  }
}

function Get-Layer($Doc, [string]$Name) {
  try { return $Doc.Layers.Item($Name) } catch { return $null }
}

function Get-Label($Entity) {
  return "$(Get-ShortType ([string]$Entity.ObjectName)) $([string]$Entity.Handle)"
}

function Assert-InTime {
  if (Test-OutOfTime) { Fail 'TIME_BUDGET' 'Checking this change took too long for one request. Split it into smaller changes.' }
}

function Get-WritableEntity($Doc, [string]$Handle, $LayoutMap, $Plan) {
  Assert-InTime
  if ($Plan.gone.ContainsKey($Handle)) { Fail 'TARGET_NOT_FOUND' "Handle $Handle is erased earlier in this change." }
  try { $entity = $Doc.HandleToObject($Handle) } catch { Fail 'TARGET_NOT_FOUND' "No object with handle $Handle in this drawing. Read the selection again." }
  $layerName = $null
  try { $layerName = [string]$entity.Layer } catch { }
  if ([string]::IsNullOrEmpty($layerName)) {
    Fail 'NOT_DRAWING_OBJECT' "Handle $Handle is a $(Get-ShortType ([string]$entity.ObjectName)), not a drawing object. Use handles from inertia_cad_query_objects or inertia_cad_get_selection."
  }
  if (-not $LayoutMap.ContainsKey([string]$entity.OwnerID)) {
    Fail 'NESTED_TARGET' "$(Get-Label $entity) is inside a block definition; editing it would change every insert of that block. Pick top-level objects."
  }
  $layer = Get-Layer $Doc $layerName
  if ($null -ne $layer -and [bool]$layer.Lock) { Fail 'LOCKED' "$(Get-Label $entity) is on locked layer $layerName. Unlock it in AutoCAD first." }
  $Plan.fingerprints['entity:' + $Handle] = Get-Fingerprint $entity
  [void](Get-TargetCorners $Plan $Handle $entity)
  return $entity
}

function Assert-NotDimension($Entity, [string]$Kind) {
  if ((Get-ShortType ([string]$Entity.ObjectName)) -eq 'DIMENSION') { Fail 'UNSUPPORTED_TARGET' "$(Get-Label $Entity) is a dimension; $Kind would falsify it. Add a new dimension instead." }
}

function Get-Block($Doc, [string]$Name) {
  if ($Name.StartsWith('*') -or $Name.Contains('|')) { Fail 'UNSUPPORTED_TARGET' "`"$Name`" is an anonymous or xref block; insert a named block from inertia_cad_document_info." }
  $block = $null
  if ($Name -and $Name -notmatch '[<>/\\":;?,=`]') { try { $block = $Doc.Blocks.Item($Name) } catch { } }
  if ($null -eq $block) { Fail 'BLOCK_NOT_FOUND' "No block named `"$Name`" in this drawing; inertia_cad_document_info lists its blocks." }
  if ([bool]$block.IsXRef -or [bool]$block.IsLayout) { Fail 'UNSUPPORTED_TARGET' "`"$Name`" is an xref or layout block, not one to insert." }
  # A block definition enumerates its entities, so a bare return would hand back those instead.
  return , $block
}

# --- Preview bounds -----------------------------------------------------
# Only previews track bounds: the union of what each change touches, before and (where cheap) after.

function Add-Bounds($Plan, $Points) {
  if ($null -eq $Plan.bounds) { return }
  foreach ($point in $Points) {
    for ($i = 0; $i -lt 2; $i++) {
      $value = [double]$point[$i]
      if ($value -lt $Plan.bounds.min[$i]) { $Plan.bounds.min[$i] = $value }
      if ($value -gt $Plan.bounds.max[$i]) { $Plan.bounds.max[$i] = $value }
    }
  }
}

function Get-Corners($Extent) {
  if ($null -eq $Extent) { return , @() }
  $a = $Extent.min; $b = $Extent.max
  return , @(@([double]$a[0], [double]$a[1]), @([double]$b[0], [double]$a[1]), @([double]$b[0], [double]$b[1]), @([double]$a[0], [double]$b[1]))
}

# A target's bounding-box corners as earlier operations in this batch leave them.
function Get-TargetCorners($Plan, [string]$Handle, $Entity) {
  if ($null -eq $Plan.bounds) { return , @() }
  if (-not $Plan.corners.ContainsKey($Handle)) {
    $Plan.corners[$Handle] = Get-Corners (Get-Extent $Entity)
    Add-Bounds $Plan $Plan.corners[$Handle]
  }
  return , $Plan.corners[$Handle]
}

# -Keep adds the mapped box (a copy) without moving the target's own box.
function Update-Corners($Plan, [string]$Handle, [scriptblock]$Map, [switch]$Keep) {
  if ($null -eq $Plan.bounds) { return }
  $mapped = @(foreach ($corner in $Plan.corners[$Handle]) { , (& $Map $corner) })
  Add-Bounds $Plan $mapped
  if (-not $Keep) { $Plan.corners[$Handle] = $mapped }
}

function Get-PlanBox($Plan) {
  $bounds = $Plan.bounds
  if ($null -eq $bounds -or -not ($bounds.min[0] -le $bounds.max[0])) { return $null }
  return [ordered]@{ min = @((Get-Rounded $bounds.min[0]), (Get-Rounded $bounds.min[1])); max = @((Get-Rounded $bounds.max[0]), (Get-Rounded $bounds.max[1])) }
}

function Get-Mirrored($Point, $A, $B) {
  $dx = $B[0] - $A[0]; $dy = $B[1] - $A[1]
  $t = (($Point[0] - $A[0]) * $dx + ($Point[1] - $A[1]) * $dy) / ($dx * $dx + $dy * $dy)
  return , @((2 * ($A[0] + $t * $dx) - $Point[0]), (2 * ($A[1] + $t * $dy) - $Point[1]))
}

function Add-Change($Plan, [string]$Op, [string]$Target, [string]$Field, $Before, $After) {
  [void]$Plan.changes.Add([ordered]@{ op = $Op; target = $Target; field = $Field; before = $Before; after = $After })
}

$OffsetTypes = @('AcDbLine', 'AcDbArc', 'AcDbCircle', 'AcDbPolyline', 'AcDbEllipse', 'AcDbSpline')
$LoopTypes = $OffsetTypes + 'AcDb2dPolyline'
$RotatableTypes = @('AcDbBlockReference', 'AcDbMInsertBlock', 'AcDbText', 'AcDbMText')
# The points a move or rotate row shows, named as query rows name them.
$ShapePoints = @{
  AcDbBlockReference = @('InsertionPoint'); AcDbMInsertBlock = @('InsertionPoint'); AcDbText = @('InsertionPoint'); AcDbMText = @('InsertionPoint')
  AcDbCircle = @('Center'); AcDbLine = @('StartPoint', 'EndPoint')
}
$PointFields = @{ InsertionPoint = 'position'; Center = 'center'; StartPoint = 'start'; EndPoint = 'end' }

# Key points and rotation as earlier operations in this batch leave them; $null for other types.
function Get-Shape($Entity, [string]$Handle, $Shapes) {
  $names = $ShapePoints[[string]$Entity.ObjectName]
  if ($null -eq $names) { return $null }
  if (-not $Shapes.ContainsKey($Handle)) {
    $points = [ordered]@{}
    foreach ($name in $names) { $points[$name] = [double[]]@($Entity.$name) }
    $rotation = $null
    if ($RotatableTypes -contains [string]$Entity.ObjectName) { $rotation = [double]$Entity.Rotation }
    $Shapes[$Handle] = @{ points = $points; rotation = $rotation }
  }
  return $Shapes[$Handle]
}

function Get-ShapeRow($Shape, [switch]$Rotation) {
  $row = [ordered]@{}
  foreach ($name in $Shape.points.Keys) { $row[$PointFields[$name]] = Get-Point $Shape.points[$name] }
  if ($Rotation -and $null -ne $Shape.rotation) { $row.rotationDeg = Get-RotationDeg $Shape.rotation }
  return $row
}

function Format-Vector($Vector) {
  $parts = @((Get-Rounded $Vector[0]), (Get-Rounded $Vector[1]))
  if ($Vector[2] -ne 0) { $parts += Get-Rounded $Vector[2] }
  return "[$($parts -join ', ')]"
}

function Get-Count($Value) {
  $count = 0
  if (-not [int]::TryParse([string]$Value, [ref]$count) -or $count -lt 1 -or $count -gt 50) { Fail 'INVALID_REQUEST' 'count must be a whole number from 1 to 50.' }
  return $count
}

function Get-Flat($Points, [int]$Min, [string]$Name) {
  $items = @($Points)
  if ($items.Count -lt $Min -or $items.Count -gt 1000) { Fail 'INVALID_REQUEST' "$Name needs $Min to 1000 [x, y] pairs." }
  $flat = New-Object 'double[]' ($items.Count * 2)
  for ($i = 0; $i -lt $items.Count; $i++) { $point = Get-Coordinate $items[$i] "$Name[$i]"; $flat[2 * $i] = $point[0]; $flat[2 * $i + 1] = $point[1] }
  return , $flat
}

function Get-FlatPoints($Flat) {
  return , @(for ($i = 0; $i -lt $Flat.Count; $i += 2) { , @($Flat[$i], $Flat[$i + 1]) })
}

function New-Plan($Acad, $Doc, $Operations, [switch]$Bounds) {
  $operations = @($Operations)
  if ($operations.Count -eq 0) { Fail 'INVALID_REQUEST' 'Give at least one operation.' }
  if ($operations.Count -gt $MaxOperations) { Fail 'INVALID_REQUEST' "At most $MaxOperations operations per change." }
  $targetCount = 0
  foreach ($op in $operations) { $targetCount += @($op.handles | Where-Object { $null -ne $_ }).Count }
  if ($targetCount -gt $MaxPlanTargets) { Fail 'INVALID_REQUEST' "At most $MaxPlanTargets target handles per change. Split it into smaller changes." }
  $plan = @{
    changes      = New-Object System.Collections.ArrayList
    fingerprints = [ordered]@{}
    steps        = New-Object System.Collections.ArrayList
    warnings     = New-Object System.Collections.ArrayList
    gone         = @{}
    corners      = @{}
    bounds       = $null
    creates      = 0
  }
  if ($Bounds) { $plan.bounds = @{ min = [double[]]@([double]::PositiveInfinity, [double]::PositiveInfinity); max = [double[]]@([double]::NegativeInfinity, [double]::NegativeInfinity) } }
  $layoutMap = Get-LayoutMap $Doc
  $newLayers = @{}
  # Layers as earlier operations in this batch leave them, so a later one is never skipped as a no-op.
  $projectedLayers = @{}
  # Key points and rotations as earlier operations in this batch leave them.
  $shapes = @{}
  foreach ($op in $operations) {
    Assert-InTime
    $kind = [string]$op.op
    switch ($kind) {
      'acad.create_layer' {
        $name = [string]$op.name
        Test-LayerName $name
        if ($null -ne (Get-Layer $Doc $name) -or $newLayers.ContainsKey($name.ToLowerInvariant())) { Fail 'ALREADY_EXISTS' "Layer `"$name`" already exists." }
        $color = $null
        if ($null -ne $op.color) { $color = [int]$op.color; if ($color -lt 1 -or $color -gt 255) { Fail 'INVALID_REQUEST' 'Layer color must be an AutoCAD color index from 1 to 255.' } }
        $newLayers[$name.ToLowerInvariant()] = $true
        $plan.fingerprints['layer:' + $name] = 'absent'
        Add-Change $plan $kind $name 'layer' $null 'created'
        [void]$plan.steps.Add(@{ kind = $kind; name = $name; color = $color })
      }
      'acad.set_layer' {
        $name = [string]$op.layer
        if ($null -eq (Get-Layer $Doc $name) -and -not $newLayers.ContainsKey($name.ToLowerInvariant())) { Fail 'LAYER_NOT_FOUND' "No layer named `"$name`". Create it first with acad.create_layer." }
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          $current = [string]$entity.Layer
          if ($projectedLayers.ContainsKey($handle)) { $current = $projectedLayers[$handle] }
          if ($current -ieq $name) { [void]$plan.warnings.Add("$(Get-Label $entity) is already on layer $name."); continue }
          $projectedLayers[$handle] = $name
          Add-Change $plan $kind (Get-Label $entity) 'layer' $current $name
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; value = $name })
        }
      }
      'acad.set_color' {
        $color = [int]$op.color
        if ($color -lt 0 -or $color -gt 256) { Fail 'INVALID_REQUEST' 'color must be an AutoCAD color index: 0 ByBlock, 1-255, 256 ByLayer.' }
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          Add-Change $plan $kind (Get-Label $entity) 'color' ([int]$entity.Color) $color
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; value = $color })
        }
      }
      'acad.set_text' {
        $text = [string]$op.text
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          if (@('AcDbText', 'AcDbMText') -notcontains [string]$entity.ObjectName) { Fail 'UNSUPPORTED_TARGET' "$(Get-Label $entity) is not TEXT or MTEXT." }
          Add-Change $plan $kind (Get-Label $entity) 'text' (Limit-Text $entity.TextString 200) (Limit-Text $text 200)
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; value = $text })
        }
      }
      'acad.set_attribute' {
        $tag = [string]$op.tag
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          if ([string]$entity.ObjectName -ne 'AcDbBlockReference' -or -not [bool]$entity.HasAttributes) { Fail 'UNSUPPORTED_TARGET' "$(Get-Label $entity) is not a block insert with attributes." }
          $found = @(@($entity.GetAttributes()) | Where-Object { [string]$_.TagString -ieq $tag })
          if ($found.Count -eq 0) { Fail 'ATTRIBUTE_NOT_FOUND' "$(Get-Label $entity) has no attribute $tag." }
          if ($found.Count -gt 1) { Fail 'AMBIGUOUS_ATTRIBUTE' "$(Get-Label $entity) has several attributes tagged $tag." }
          Add-Change $plan $kind "$(Get-Label $entity) [$tag]" 'attribute' (Limit-Text $found[0].TextString 200) (Limit-Text $op.value 200)
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; tag = $tag; value = [string]$op.value })
        }
      }
      'acad.move' {
        $vector = Get-Coordinate $op.vector 'vector'
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          $shape = Get-Shape $entity $handle $shapes
          if ($null -eq $shape) {
            Add-Change $plan $kind (Get-Label $entity) 'position' $null "moved by $(Format-Vector $vector)"
          } else {
            $before = Get-ShapeRow $shape
            foreach ($point in $shape.points.Values) { for ($i = 0; $i -lt 3; $i++) { $point[$i] += $vector[$i] } }
            Add-Change $plan $kind (Get-Label $entity) 'position' $before (Get-ShapeRow $shape)
          }
          Update-Corners $plan $handle { param($p) @(($p[0] + $vector[0]), ($p[1] + $vector[1])) }
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; vector = $vector })
        }
      }
      'acad.set_rotation' {
        $rotation = Get-Radians $op.rotationDeg 'rotationDeg'
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          if ($RotatableTypes -notcontains [string]$entity.ObjectName) { Fail 'UNSUPPORTED_TARGET' "$(Get-Label $entity) is not an INSERT, TEXT or MTEXT; use acad.rotate with a basePoint." }
          $shape = Get-Shape $entity $handle $shapes
          $current = Get-RotationDeg $shape.rotation
          $target = Get-RotationDeg $rotation
          if ($current -eq $target) { [void]$plan.warnings.Add("$(Get-Label $entity) is already at $target degrees."); continue }
          $shape.rotation = $rotation
          Add-Change $plan $kind (Get-Label $entity) 'rotationDeg' $current $target
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; value = $rotation })
        }
      }
      'acad.rotate' {
        $base = Get-Coordinate $op.basePoint 'basePoint'
        $angle = Get-Radians $op.angleDeg 'angleDeg'
        $cos = [Math]::Cos($angle)
        $sin = [Math]::Sin($angle)
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          $shape = Get-Shape $entity $handle $shapes
          if ($null -eq $shape) {
            Add-Change $plan $kind (Get-Label $entity) 'placement' $null "rotated $(Get-Degrees $angle)$([char]0xB0) about $(Format-Vector $base)"
          } else {
            $before = Get-ShapeRow $shape -Rotation
            foreach ($point in $shape.points.Values) {
              $dx = $point[0] - $base[0]
              $dy = $point[1] - $base[1]
              $point[0] = $base[0] + $dx * $cos - $dy * $sin
              $point[1] = $base[1] + $dx * $sin + $dy * $cos
            }
            if ($null -ne $shape.rotation) { $shape.rotation += $angle }
            Add-Change $plan $kind (Get-Label $entity) 'placement' $before (Get-ShapeRow $shape -Rotation)
          }
          Update-Corners $plan $handle { param($p) @(($base[0] + ($p[0] - $base[0]) * $cos - ($p[1] - $base[1]) * $sin), ($base[1] + ($p[0] - $base[0]) * $sin + ($p[1] - $base[1]) * $cos)) }
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; base = $base; angle = $angle })
        }
      }
      'acad.erase' {
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          $definition = Get-BlockDefinitionDigest $Doc $entity
          if ($null -ne $definition) { $plan.fingerprints['block:' + $handle] = $definition }
          Add-Change $plan $kind (Get-Label $entity) 'entity' 'present' 'erased'
          $plan.gone[$handle] = $true
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity })
        }
      }
      'acad.copy' {
        $vector = Get-Coordinate $op.vector 'vector'
        $count = 1
        if ($null -ne $op.count) { $count = Get-Count $op.count }
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          $plan.creates += $count
          if ($plan.creates -gt $MaxPlanTargets) { Fail 'INVALID_REQUEST' "At most $MaxPlanTargets copies per change. Split it into smaller changes." }
          Update-Corners $plan $handle { param($p) @(($p[0] + $vector[0] * $count), ($p[1] + $vector[1] * $count)) } -Keep
          Add-Change $plan $kind (Get-Label $entity) 'copies' $null $(if ($count -eq 1) { "1 copy offset by $(Format-Vector $vector)" } else { "$count copies, offset by $(Format-Vector $vector) each" })
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; vector = $vector; count = $count })
        }
      }
      'acad.mirror' {
        $p1 = Get-Coordinate $op.p1 'p1'
        $p2 = Get-Coordinate $op.p2 'p2'
        if ($p1[0] -eq $p2[0] -and $p1[1] -eq $p2[1]) { Fail 'INVALID_REQUEST' 'p1 and p2 must be different points.' }
        $keep = $op.keepSource -ne $false
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          Assert-NotDimension $entity $kind
          Update-Corners $plan $handle { param($p) Get-Mirrored $p $p1 $p2 } -Keep
          if (-not $keep) { $plan.gone[$handle] = $true }
          Add-Change $plan $kind (Get-Label $entity) 'mirror' $null "mirrored copy about $(Format-Vector $p1) to $(Format-Vector $p2)$(if (-not $keep) { ', original erased' })"
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; p1 = $p1; p2 = $p2; keep = $keep })
        }
      }
      'acad.scale' {
        $base = Get-Coordinate $op.basePoint 'basePoint'
        $factor = Get-Number $op.factor 'factor'
        if (-not ($factor -gt 0)) { Fail 'INVALID_REQUEST' 'factor must be greater than 0.' }
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          Assert-NotDimension $entity $kind
          $shape = Get-Shape $entity $handle $shapes
          if ($null -eq $shape) {
            Add-Change $plan $kind (Get-Label $entity) 'scale' $null "scaled x$(Get-Rounded $factor 6) about $(Format-Vector $base)"
          } else {
            $before = Get-ShapeRow $shape
            foreach ($point in $shape.points.Values) { for ($i = 0; $i -lt 3; $i++) { $point[$i] = $base[$i] + ($point[$i] - $base[$i]) * $factor } }
            Add-Change $plan $kind (Get-Label $entity) 'scale' $before (Get-ShapeRow $shape)
          }
          Update-Corners $plan $handle { param($p) @(($base[0] + ($p[0] - $base[0]) * $factor), ($base[1] + ($p[1] - $base[1]) * $factor)) }
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; base = $base; factor = $factor })
        }
      }
      'acad.offset' {
        $handles = Get-Targets $op
        if ($handles.Count -ne 1) { Fail 'INVALID_REQUEST' 'acad.offset takes one handle.' }
        $distance = Get-Number $op.distance 'distance'
        if ($distance -eq 0 -or [Math]::Abs($distance) -gt $MaxCoordinate) { Fail 'INVALID_REQUEST' 'distance must be a non-zero length; its sign picks the side.' }
        $entity = Get-WritableEntity $Doc $handles[0] $layoutMap $plan
        if ($OffsetTypes -notcontains [string]$entity.ObjectName) { Fail 'UNSUPPORTED_TARGET' "$(Get-Label $entity) cannot be offset; use a LINE, ARC, CIRCLE, LWPOLYLINE, ELLIPSE or SPLINE." }
        $corners = Get-TargetCorners $plan $handles[0] $entity
        if ($corners.Count -gt 0) {
          $xs = $corners | ForEach-Object { $_[0] }; $ys = $corners | ForEach-Object { $_[1] }
          $d = [Math]::Abs($distance)
          Add-Bounds $plan @(@((($xs | Measure-Object -Minimum).Minimum - $d), (($ys | Measure-Object -Minimum).Minimum - $d)), @((($xs | Measure-Object -Maximum).Maximum + $d), (($ys | Measure-Object -Maximum).Maximum + $d)))
        }
        Add-Change $plan $kind (Get-Label $entity) 'offset' $null "offset copy at $(Get-Rounded $distance)"
        [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; distance = $distance })
      }
      { @('acad.add_line', 'acad.add_polyline', 'acad.add_circle', 'acad.add_text', 'acad.add_arc', 'acad.add_hatch', 'acad.add_dimension', 'acad.insert_block') -contains $_ } {
        $layer = $null
        if ($op.layer) {
          $layer = [string]$op.layer
          if ($null -eq (Get-Layer $Doc $layer) -and -not $newLayers.ContainsKey($layer.ToLowerInvariant())) { Fail 'LAYER_NOT_FOUND' "No layer named `"$layer`"." }
        }
        $step = @{ kind = $kind; layer = $layer }
        switch ($kind) {
          'acad.add_line' {
            $step.start = Get-Coordinate $op.start 'start'; $step.end = Get-Coordinate $op.end 'end'
            $summary = "line from $(($step.start | ForEach-Object { Get-Rounded $_ }) -join ', ') to $(($step.end | ForEach-Object { Get-Rounded $_ }) -join ', ')"
            Add-Bounds $plan @($step.start, $step.end)
          }
          'acad.add_polyline' {
            $step.coordinates = Get-Flat $op.points 2 'points'; $step.closed = ($op.closed -eq $true)
            $summary = "polyline with $($step.coordinates.Count / 2) vertices$(if ($step.closed) { ', closed' })"
            Add-Bounds $plan (Get-FlatPoints $step.coordinates)
          }
          { @('acad.add_circle', 'acad.add_arc') -contains $_ } {
            $step.center = Get-Coordinate $op.center 'center'; $step.radius = [double]$op.radius
            if (-not ($step.radius -gt 0 -and $step.radius -lt $MaxCoordinate)) { Fail 'INVALID_REQUEST' 'radius must be greater than 0.' }
            $summary = "circle r=$(Get-Rounded $step.radius) at $(($step.center | ForEach-Object { Get-Rounded $_ }) -join ', ')"
            if ($kind -eq 'acad.add_arc') {
              $step.start = Get-Radians $op.startDeg 'startDeg'; $step.end = Get-Radians $op.endDeg 'endDeg'
              $summary = "arc r=$(Get-Rounded $step.radius) at $(Format-Vector $step.center) from $(Get-Degrees $step.start) to $(Get-Degrees $step.end) degrees"
            }
            $c = $step.center; $r = $step.radius
            Add-Bounds $plan @(@(($c[0] - $r), ($c[1] - $r)), @(($c[0] + $r), ($c[1] + $r)))
          }
          'acad.insert_block' {
            $step.name = [string](Get-Block $Doc ([string]$op.name)).Name
            $step.position = Get-Coordinate $op.position 'position'
            $step.rotation = 0.0
            if ($null -ne $op.rotationDeg) { $step.rotation = Get-Radians $op.rotationDeg 'rotationDeg' }
            $step.scale = 1.0
            if ($null -ne $op.scale) { $step.scale = Get-Number $op.scale 'scale'; if (-not ($step.scale -gt 0)) { Fail 'INVALID_REQUEST' 'scale must be greater than 0.' } }
            $summary = "$($step.name) at $(Format-Vector $step.position)$(if ($step.rotation -ne 0) { ", rotated $(Get-RotationDeg $step.rotation) degrees" })$(if ($step.scale -ne 1) { ", scale $(Get-Rounded $step.scale 6)" })"
            Add-Bounds $plan @(, $step.position)
          }
          'acad.add_hatch' {
            $step.pattern = 'SOLID'
            if ($op.pattern) { $step.pattern = ([string]$op.pattern).ToUpperInvariant() }
            if ($step.pattern -notmatch '^[A-Z0-9_-]{1,64}$') { Fail 'INVALID_REQUEST' 'pattern must be SOLID or a hatch pattern name (letters, digits, _ and -).' }
            $step.scale = 1.0
            if ($null -ne $op.scale) { $step.scale = Get-Number $op.scale 'scale'; if (-not ($step.scale -gt 0)) { Fail 'INVALID_REQUEST' 'scale must be greater than 0.' } }
            $step.angle = 0.0
            if ($null -ne $op.angleDeg) { $step.angle = Get-Radians $op.angleDeg 'angleDeg' }
            $boundary = @($op.boundary | Where-Object { $null -ne $_ })
            if ($boundary.Count -gt 0 -and @($boundary | Where-Object { $_ -is [string] }).Count -eq $boundary.Count) {
              if ($boundary.Count -gt $MaxTargets) { Fail 'INVALID_REQUEST' "boundary accepts at most $MaxTargets handles." }
              $step.loop = @(foreach ($handle in $boundary) {
                  $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
                  if ($LoopTypes -notcontains [string]$entity.ObjectName) { Fail 'UNSUPPORTED_TARGET' "$(Get-Label $entity) cannot bound a hatch; use closed polylines, circles, ellipses, splines, or lines and arcs that form a loop." }
                  $entity
                })
              $where = "inside $($boundary.Count) boundary object$(if ($boundary.Count -gt 1) { 's' })"
            } else {
              $step.coordinates = Get-Flat $op.boundary 3 'boundary'
              Add-Bounds $plan (Get-FlatPoints $step.coordinates)
              $where = "inside a $($step.coordinates.Count / 2)-point boundary"
            }
            $summary = "$($step.pattern) hatch $where$(if ($step.pattern -ne 'SOLID') { ", scale $(Get-Rounded $step.scale 6), angle $(Get-Degrees $step.angle)" })"
          }
          'acad.add_dimension' {
            $step.linear = [string]$op.kind -eq 'linear'
            if (-not $step.linear -and [string]$op.kind -ne 'aligned') { Fail 'INVALID_REQUEST' 'kind must be aligned or linear.' }
            $step.p1 = Get-Coordinate $op.p1 'p1'; $step.p2 = Get-Coordinate $op.p2 'p2'; $step.textPosition = Get-Coordinate $op.textPosition 'textPosition'
            if ($step.p1[0] -eq $step.p2[0] -and $step.p1[1] -eq $step.p2[1]) { Fail 'INVALID_REQUEST' 'p1 and p2 must be different points.' }
            $step.rotation = 0.0
            if ($null -ne $op.rotationDeg) {
              if (-not $step.linear) { Fail 'INVALID_REQUEST' 'rotationDeg applies to linear dimensions only.' }
              $step.rotation = Get-Radians $op.rotationDeg 'rotationDeg'
            }
            $summary = "$([string]$op.kind) dimension from $(Format-Vector $step.p1) to $(Format-Vector $step.p2)$(if ($step.rotation -ne 0) { ", rotated $(Get-RotationDeg $step.rotation) degrees" }), current dim style"
            Add-Bounds $plan @($step.p1, $step.p2, $step.textPosition)
          }
          'acad.add_text' {
            $step.position = Get-Coordinate $op.position 'position'; $step.height = [double]$op.height; $step.text = [string]$op.text
            if (-not ($step.height -gt 0 -and $step.height -lt $MaxCoordinate)) { Fail 'INVALID_REQUEST' 'height must be greater than 0.' }
            if ([string]::IsNullOrEmpty($step.text)) { Fail 'INVALID_REQUEST' 'text must not be empty.' }
            $step.rotation = 0.0
            if ($null -ne $op.rotationDeg) { $step.rotation = [double]$op.rotationDeg * [Math]::PI / 180 }
            $summary = "text `"$(Limit-Text $step.text 60)`""
            Add-Bounds $plan @(, $step.position)
          }
        }
        $where = 'model space'
        if ($layer) { $where += " on layer $layer" }
        Add-Change $plan $kind "new $($kind -replace '^acad\.(add|insert)_', '')" 'geometry' $null "$summary, $where"
        [void]$plan.steps.Add($step)
      }
      default { Fail 'UNSUPPORTED_OPERATION' "AutoCAD does not support `"$kind`"." }
    }
  }
  return $plan
}

# Records when a failed step could not remove what it created, so the apply reports it.
function Undo-Creation($Object) {
  try { $Object.Delete() } catch { $script:StepLeftChanges = $true }
}

function Invoke-Step($Doc, $Step, $Created) {
  switch ($Step.kind) {
    'acad.create_layer' {
      $layer = $Doc.Layers.Add($Step.name)
      try { if ($null -ne $Step.color) { $layer.Color = $Step.color } } catch { Undo-Creation $layer; throw }
    }
    'acad.set_layer' { $Step.entity.Layer = (Get-Layer $Doc $Step.value).Name }
    'acad.set_color' { $Step.entity.Color = $Step.value }
    'acad.set_text' { $Step.entity.TextString = $Step.value }
    'acad.set_attribute' {
      foreach ($attribute in @($Step.entity.GetAttributes())) { if ([string]$attribute.TagString -ieq $Step.tag) { $attribute.TextString = $Step.value } }
    }
    'acad.move' {
      $origin = New-Object 'double[]' 3
      $Step.entity.Move($origin, $Step.vector)
    }
    'acad.set_rotation' { $Step.entity.Rotation = $Step.value }
    'acad.rotate' { $Step.entity.Rotate($Step.base, $Step.angle) }
    'acad.erase' { $Step.entity.Delete() }
    'acad.scale' { $Step.entity.ScaleEntity($Step.base, $Step.factor) }
    default {
      # A step either completes or leaves nothing behind, so a failure in the first step changed nothing.
      $made = New-Object System.Collections.ArrayList
      try { New-StepObjects $Doc $Step $made } catch { foreach ($object in $made) { Undo-Creation $object }; throw }
      foreach ($object in $made) { [void]$Created.Add([ordered]@{ handle = [string]$object.Handle; type = (Get-ShortType ([string]$object.ObjectName)) }) }
    }
  }
}

function Add-OuterLoop($Hatch, $Objects) {
  if ($Hatch -is [System.__ComObject]) { [InertiaCad.Com]::AppendOuterLoop($Hatch, [object[]]$Objects) } else { $Hatch.AppendOuterLoop([object[]]$Objects) }
}

# Adds each object to $Made as soon as it exists, so a failure can remove it again.
function New-StepObjects($Doc, $Step, $Made) {
  switch ($Step.kind) {
    'acad.copy' {
      $origin = New-Object 'double[]' 3
      for ($i = 1; $i -le $Step.count; $i++) {
        $copy = $Step.entity.Copy()
        [void]$Made.Add($copy)
        $copy.Move($origin, [double[]]@(($Step.vector[0] * $i), ($Step.vector[1] * $i), ($Step.vector[2] * $i)))
      }
      return
    }
    'acad.mirror' {
      [void]$Made.Add($Step.entity.Mirror($Step.p1, $Step.p2))
      if (-not $Step.keep) { $Step.entity.Delete() }
      return
    }
    'acad.offset' {
      foreach ($object in @($Step.entity.Offset($Step.distance))) { [void]$Made.Add($object) }
      return
    }
  }
  $space = $Doc.ModelSpace
  switch ($Step.kind) {
    'acad.add_line' { $entity = $space.AddLine($Step.start, $Step.end) }
    'acad.add_polyline' { $entity = $space.AddLightWeightPolyline($Step.coordinates) }
    'acad.add_circle' { $entity = $space.AddCircle($Step.center, $Step.radius) }
    'acad.add_arc' { $entity = $space.AddArc($Step.center, $Step.radius, $Step.start, $Step.end) }
    'acad.add_text' { $entity = $space.AddText($Step.text, $Step.position, $Step.height) }
    'acad.insert_block' { $entity = $space.InsertBlock($Step.position, $Step.name, $Step.scale, $Step.scale, $Step.scale, $Step.rotation) }
    'acad.add_hatch' { $entity = $space.AddHatch(1, $Step.pattern, $false) }
    'acad.add_dimension' {
      if ($Step.linear) { $entity = $space.AddDimRotated($Step.p1, $Step.p2, $Step.textPosition, $Step.rotation) }
      else { $entity = $space.AddDimAligned($Step.p1, $Step.p2, $Step.textPosition) }
    }
  }
  [void]$Made.Add($entity)
  if ($Step.kind -eq 'acad.add_polyline' -and $Step.closed) { $entity.Closed = $true }
  if ($Step.kind -eq 'acad.add_text' -and $Step.rotation -ne 0) { $entity.Rotation = $Step.rotation }
  if ($Step.layer) { $entity.Layer = (Get-Layer $Doc $Step.layer).Name }
  # New objects otherwise take CECOLOR, CELTYPE and CELWEIGHT, which may hold a one-off override.
  $entity.Color = 256
  $entity.Linetype = 'ByLayer'
  $entity.Lineweight = -1
  if ($Step.kind -eq 'acad.add_hatch') {
    if ($Step.pattern -ne 'SOLID') { $entity.PatternScale = $Step.scale; $entity.PatternAngle = $Step.angle }
    $loop = $Step.loop
    $temporary = $null
    try {
      if ($null -ne $Step.coordinates) {
        $temporary = $space.AddLightWeightPolyline($Step.coordinates)
        $temporary.Closed = $true
        $loop = @($temporary)
      }
      Add-OuterLoop $entity $loop
      $entity.Evaluate()
    } finally {
      if ($null -ne $temporary) { try { $temporary.Delete() } catch { $script:StepLeftChanges = $true; throw } }
    }
  }
}

function Get-StaleKeys($Expected, $Actual) {
  $expectedMap = @{}
  if ($null -ne $Expected) { foreach ($property in $Expected.PSObject.Properties) { $expectedMap[$property.Name] = [string]$property.Value } }
  $stale = New-Object System.Collections.ArrayList
  foreach ($key in $Actual.Keys) { if ($expectedMap[$key] -ne [string]$Actual[$key]) { [void]$stale.Add($key) } }
  foreach ($key in $expectedMap.Keys) { if (-not $Actual.Contains($key)) { [void]$stale.Add($key) } }
  return , $stale.ToArray()
}

function Get-Preview($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId)
  $plan = New-Plan $Acad $doc $Params.operations -Bounds
  $result = [ordered]@{
    documentId   = Get-DocumentId $doc
    changes      = $plan.changes.ToArray()
    fingerprints = $plan.fingerprints
    warnings     = @($plan.warnings | Select-Object -Unique)
  }
  $box = Get-PlanBox $plan
  if ($null -ne $box) { $result.bbox = $box }
  return $result
}

function Invoke-Apply($Acad, $Params) {
  $documentId = [string]$Params.documentId
  $doc = Resolve-Document $Acad $documentId -RequireActive
  $lock = Enter-ApplyLock
  try {
    $plan = New-Plan $Acad $doc $Params.operations
    $stale = Get-StaleKeys $Params.expectedFingerprints $plan.fingerprints
    if ($stale.Count -gt 0) { Fail 'TARGET_CHANGED' "The drawing changed since the preview ($((@($stale) | Select-Object -First 5) -join ', ')). Preview the change again." }
    if ([int]$doc.GetVariable('CMDACTIVE') -ne 0) { Fail 'HOST_BUSY' 'AutoCAD has a command or dialog open. Finish it and try again.' }
    if (-not ([int]$doc.GetVariable('UNDOCTL') -band 1)) {
      Fail 'UNDO_DISABLED' 'Undo is turned off in this drawing, so the edit could not be reverted. Turn it back on in AutoCAD (UNDO, then Control, All) and try again.'
    }
    return Invoke-Steps $Acad $doc $plan
  } finally {
    Exit-ApplyLock $lock
  }
}

# RPC failures leave it unknown whether the call ran inside AutoCAD; AutoCAD's own refusals mean it did not.
function Test-RpcFailure($ErrorRecord) {
  for ($exception = $ErrorRecord.Exception; $null -ne $exception; $exception = $exception.InnerException) {
    if ($exception -isnot [System.Runtime.InteropServices.COMException]) { continue }
    $hr = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]$exception.HResult), 0)
    $code = $hr -band 0xFFFF
    return (($hr -shr 16) -eq 0x8001) -or (($hr -shr 16) -eq 0x8007 -and $code -ge 1700 -and $code -le 1999)
  }
  return $false
}

# From the undo mark on the edit may have reached AutoCAD, so no failure here may read as "not sent": the server would retry and duplicate it.
function Invoke-Steps($Acad, $Doc, $Plan) {
  $created = New-Object System.Collections.ArrayList
  $done = 0
  $total = $Plan.steps.Count
  $started = $false
  $script:StepLeftChanges = $false
  try {
    $Doc.StartUndoMark()
    $started = $true
    foreach ($step in $Plan.steps) { Invoke-Step $Doc $step $created; $done++ }
  } catch {
    $shape = Get-ErrorShape $_
    if ($done -gt 0 -or $script:StepLeftChanges) { Fail 'PARTIALLY_APPLIED' "AutoCAD stopped after $done of $total steps: $($shape.message). One Undo in AutoCAD reverts the steps that ran." }
    if ($started -and (Test-RpcFailure $_)) {
      Fail 'APPLY_UNCONFIRMED' 'AutoCAD stopped answering during the edit, so it is unknown whether it ran. Check the drawing before trying again; if it ran, one Undo reverts it.'
    }
    Fail 'APPLY_FAILED' "AutoCAD refused the edit, so nothing was changed: $($shape.message)"
  } finally {
    if ($started) { try { $Doc.EndUndoMark() } catch { } }
    # COM edits can leave stale graphics; Regen(0) (acActiveViewport) redraws without touching the database.
    if ($done -gt 0) { try { $Doc.Regen(0) } catch { try { $Acad.Update() } catch { } } }
  }
  return [ordered]@{ documentId = Get-DocumentId $Doc; status = 'applied'; changes = $Plan.changes.ToArray(); created = $created.ToArray() }
}

function Get-CopyPath([string]$Path) {
  $valid = $Path -match '^[A-Za-z]:\\' -and $Path.IndexOf(':', 2) -lt 0
  if ($valid) { try { $Path = [System.IO.Path]::GetFullPath($Path) } catch { $valid = $false } }
  if (-not $valid -or $Path -notmatch '^[A-Za-z]:\\' -or $Path.IndexOf(':', 2) -ge 0) {
    Fail 'INVALID_REQUEST' 'The copy path must be a full path on a local drive, such as C:\Projects\Plan copy.dwg.'
  }
  if ($Path -notmatch '\.dwg$') { Fail 'INVALID_REQUEST' 'The copy must be a .dwg file.' }
  return $Path
}

function Save-Copy($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId)
  $path = Get-CopyPath ([string]$Params.path)
  if (Test-Path -LiteralPath $path) { Fail 'ALREADY_EXISTS' 'A file already exists at that path. Pick a new name; copies never overwrite.' }
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $path) -PathType Container)) { Fail 'INVALID_REQUEST' 'The destination folder does not exist.' }
  $source = [string]$doc.FullName
  if ([string]::IsNullOrEmpty($source) -or [int]$doc.GetVariable('DWGTITLED') -ne 1) {
    Fail 'UNTITLED_DOCUMENT' 'This drawing has never been saved. Save it once in AutoCAD, then ask for the copy again.'
  }
  # Saving to another name would switch the designer's tab to the copy, so only the file on disk is copied.
  if (Test-UnsavedChanges $doc) {
    Fail 'UNSAVED_CHANGES' 'The applied edits are in the open drawing but not in its file yet. Ask the designer to save it (Ctrl+S) when happy, then save the copy.'
  }
  try { [System.IO.File]::Copy($source, $path, $false) } catch {
    if ([System.IO.File]::Exists($path)) { Fail 'ALREADY_EXISTS' 'A file already exists at that path. Pick a new name; copies never overwrite.' }
    throw
  }
  return [ordered]@{ documentId = Get-DocumentId $doc; path = $path; bytes = (Get-Item -LiteralPath $path).Length; originalPath = $source }
}

function Read-SysVar($Doc, [string]$Name) {
  try { return $Doc.GetVariable($Name) } catch { return $null }
}

# EntityColor packs the color method in its high byte (0xC2 is RGB) and the RGB in the low three.
function Get-TrueColorHex($Layer) {
  try {
    $color = $Layer.TrueColor
    $packed = [int]$color.EntityColor
    $method = ($packed -shr 24) -band 0xFF
    if ($method -eq 0xC2) { return '#{0:x6}' -f ($packed -band 0xFFFFFF) }
    if ($method -ge 0xC0 -and $method -le 0xC8) { return $null }
    if ([int]$color.ColorMethod -ne 0xC2) { return $null }
    return '#{0:x2}{1:x2}{2:x2}' -f [int]$color.Red, [int]$color.Green, [int]$color.Blue
  } catch { return $null }
}

function Get-Lineweight($Value) {
  switch ([int]$Value) {
    -1 { return 'ByLayer' }
    -2 { return 'ByBlock' }
    -3 { return 'Default' }
  }
  return [int]$Value / 100
}

# COM has no layer transparency; AutoCAD keeps it in AcCmTransparency xdata, where 0x02000000 marks
# an alpha in the low byte. A layer without that xdata is opaque.
function Get-LayerTransparency($Layer) {
  try {
    $types = $null
    $values = $null
    $Layer.GetXData('AcCmTransparency', [ref]$types, [ref]$values)
    if ($null -eq $types) { return 0 }
    $types = @($types)
    $values = @($values)
    for ($i = 0; $i -lt $types.Count; $i++) {
      if ([int]$types[$i] -ne 1071) { continue }
      $raw = [int]$values[$i]
      if ((($raw -shr 24) -band 0xFF) -ne 2) { return $null }
      return [int][Math]::Round((255 - ($raw -band 0xFF)) * 100 / 255)
    }
    return 0
  } catch { return $null }
}

function Get-TextStyleRow($Style, [string]$Name) {
  $row = [ordered]@{ name = $Name; font = $null; height = $null; widthFactor = $null }
  try {
    $file = [string]$Style.fontFile
    if ($file) { $row.font = $file }
    # Only TrueType styles have a typeface; SHX styles are named by their font file.
    if (-not $file -or $file -match '\.(ttf|ttc|otf)$') {
      $face = ''; $bold = $false; $italic = $false; $charset = 0; $pitch = 0
      $Style.GetFont([ref]$face, [ref]$bold, [ref]$italic, [ref]$charset, [ref]$pitch)
      if ($face) { $row.font = [string]$face }
    }
  } catch { $row.partial = $true }
  Add-Field $row 'height' { Get-Rounded $Style.Height }
  Add-Field $row 'widthFactor' { Get-Rounded $Style.Width }
  return $row
}

function Get-LayoutRow($Layout) {
  $row = [ordered]@{ name = [string]$Layout.Name; paper = $null; device = $null; plotStyleTable = $null }
  Add-Field $row 'paper' { [string]$Layout.CanonicalMediaName | Where-Object { $_ } }
  Add-Field $row 'device' { [string]$Layout.ConfigName | Where-Object { $_ } }
  Add-Field $row 'plotStyleTable' { [string]$Layout.StyleSheet | Where-Object { $_ } }
  return $row
}

function Get-Info($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId)
  $style = $Params.style -eq $true
  $extents = $null
  try {
    $min = @($doc.GetVariable('EXTMIN'))
    $max = @($doc.GetVariable('EXTMAX'))
    if ((0..2 | Where-Object { -not ($min[$_] -le $max[$_]) }).Count -eq 0) { $extents = [ordered]@{ min = Get-Point $min; max = Get-Point $max } }
  } catch { }
  $outOfTime = $false
  $layers = New-Object System.Collections.ArrayList
  foreach ($layer in $doc.Layers) {
    if ($layers.Count -ge $MaxLayers) { break }
    if (Test-OutOfTime) { $outOfTime = $true; break }
    $row = [ordered]@{
      name     = [string]$layer.Name
      on       = [bool]$layer.LayerOn
      frozen   = [bool]$layer.Freeze
      locked   = [bool]$layer.Lock
      color    = [int]$layer.Color
      linetype = [string]$layer.Linetype
    }
    if ($style) {
      $row.trueColor = Get-TrueColorHex $layer
      $row.lineweight = $(try { Get-Lineweight $layer.Lineweight } catch { $null })
      $row.transparency = Get-LayerTransparency $layer
    }
    [void]$layers.Add($row)
  }
  $blocks = New-Object System.Collections.ArrayList
  $blocksTruncated = $false
  foreach ($block in $doc.Blocks) {
    $name = [string]$block.Name
    if ($name.StartsWith('*') -or $name.Contains('|') -or [bool]$block.IsLayout -or [bool]$block.IsXRef) { continue }
    if ($blocks.Count -ge $MaxBlocks) { $blocksTruncated = $true; break }
    if (Test-OutOfTime) { $outOfTime = $true; $blocksTruncated = $true; break }
    [void]$blocks.Add($name)
  }
  $result = [ordered]@{
    documentId      = Get-DocumentId $doc
    units           = [ordered]@{ insUnits = (Get-UnitsName $doc); lunits = $(try { [int]$doc.GetVariable('LUNITS') } catch { $null }) }
    extents         = $extents
    layers          = $layers.ToArray()
    layersTruncated = [int]$doc.Layers.Count -gt $layers.Count
    blocks          = $blocks.ToArray()
    blocksTruncated = $blocksTruncated
    layouts         = $(if (-not $style) { , @(foreach ($layout in $doc.Layouts) { [string]$layout.Name }) })
    entityCount     = [int]$doc.ModelSpace.Count
    ucsIsWorld      = $(try { [int]$doc.GetVariable('WORLDUCS') -eq 1 } catch { $null })
    viewTwistDeg    = $(try { Get-Rounded ([double]$doc.GetVariable('VIEWTWIST') * 180 / [Math]::PI) 3 } catch { $null })
  }
  if ($style) {
    $layouts = New-Object System.Collections.ArrayList
    $result.layoutsTruncated = $false
    foreach ($layout in $doc.Layouts) {
      if ($layouts.Count -ge $MaxLayouts) { $result.layoutsTruncated = $true; break }
      if (Test-OutOfTime) { $outOfTime = $true; $result.layoutsTruncated = $true; break }
      [void]$layouts.Add((Get-LayoutRow $layout))
    }
    $result.layouts = $layouts.ToArray()
    $textStyles = New-Object System.Collections.ArrayList
    $result.textStyles = $null; $result.textStylesTruncated = $false
    foreach ($textStyle in $doc.TextStyles) {
      if ($textStyles.Count -ge $MaxStyles) { $result.textStylesTruncated = $true; break }
      if (Test-OutOfTime) { $outOfTime = $true; $result.textStylesTruncated = $true; break }
      $name = [string]$textStyle.Name
      # Shape files for complex linetypes are unnamed text styles; xref styles carry a pipe.
      if ($name -and -not $name.Contains('|')) { [void]$textStyles.Add((Get-TextStyleRow $textStyle $name)) }
    }
    $result.textStyles = $textStyles.ToArray()
    $dimNames = New-Object System.Collections.ArrayList
    $result.dimStyles = $null; $result.dimStylesTruncated = $false
    foreach ($dimStyle in $doc.DimStyles) {
      if ($dimNames.Count -ge $MaxStyles) { $result.dimStylesTruncated = $true; break }
      if (Test-OutOfTime) { $outOfTime = $true; $result.dimStylesTruncated = $true; break }
      $name = [string]$dimStyle.Name
      if (-not $name.Contains('|')) { [void]$dimNames.Add($name) }
    }
    # DIMTXT and the rest report the active style with any unsaved overrides, as new dimensions get them.
    $result.dimStyles = [ordered]@{
      names  = $dimNames.ToArray()
      active = [ordered]@{
        name     = Read-SysVar $doc 'DIMSTYLE'
        dimtxt   = Get-Rounded (Read-SysVar $doc 'DIMTXT') 6
        dimasz   = Get-Rounded (Read-SysVar $doc 'DIMASZ') 6
        dimscale = Get-Rounded (Read-SysVar $doc 'DIMSCALE') 6
        dimdec   = $(try { [int]$doc.GetVariable('DIMDEC') } catch { $null })
      }
    }
    $result.current = [ordered]@{
      layer     = Read-SysVar $doc 'CLAYER'
      textStyle = Read-SysVar $doc 'TEXTSTYLE'
      dimStyle  = $result.dimStyles.active.name
      ltscale   = Get-Rounded (Read-SysVar $doc 'LTSCALE') 6
    }
  }
  if ($outOfTime) { $result.partial = $true; $result.timeBudgetHit = $true }
  return $result
}

function Get-Hello($Acad, $Params) {
  return [ordered]@{
    app           = 'autocad'
    appVersion    = [string]$Acad.Version
    product       = [string]$Acad.Name
    bridgeVersion = $BridgeVersion
    protocol      = $Protocol
    platform      = 'windows'
  }
}

$Methods = @{
  hello     = 'Get-Hello'
  documents = 'Get-Documents'
  selection = 'Get-Selection'
  query     = 'Find-Entities'
  capture   = 'Get-Capture'
  preview   = 'Get-Preview'
  apply     = 'Invoke-Apply'
  save_copy = 'Save-Copy'
  info      = 'Get-Info'
}

# --- Entry point --------------------------------------------------------

function Invoke-Request([string]$Raw, [scriptblock]$Connect, [System.Diagnostics.Stopwatch]$Clock = [System.Diagnostics.Stopwatch]::StartNew(), [DateTime]$StartedUtc = [DateTime]::UtcNow) {
  $response = [ordered]@{ v = $Protocol; id = $null; ok = $false }
  try {
    $request = $Raw | ConvertFrom-Json
    $response.id = $request.id
    $command = $Methods[[string]$request.method]
    if ($null -eq $command) { Fail 'UNSUPPORTED_OPERATION' "Unknown bridge method `"$($request.method)`"." }
    $params = $request.params
    if ($null -eq $params) { $params = New-Object PSObject }
    Set-Deadline $request $params $Clock $StartedUtc
    $acad = & $Connect
    if ($ReadMethods -contains [string]$request.method) { $response.result = Invoke-Read $acad $params $command } else { $response.result = & $command $acad $params }
    $response.ok = $true
  } catch {
    $response.error = Get-ErrorShape $_
  }
  return ConvertTo-Json -InputObject $response -Depth 32 -Compress
}

function Main {
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  # Callers that pipe from PowerShell prepend a byte-order mark; JSON parsing rejects it.
  $raw = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray()).TrimStart([char]0xFEFF)
  try {
    $json = Invoke-Request $raw { Initialize-Interop | Out-Null; Connect-AutoCAD } $Clock $StartedUtc
  } finally {
    if ($null -ne ('InertiaCad.MessageFilter' -as [type])) { [InertiaCad.MessageFilter]::Revoke() }
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $output = [Console]::OpenStandardOutput()
  $output.Write($bytes, 0, $bytes.Length)
  $output.Flush()
}

if ($env:INERTIA_CAD_BRIDGE_TEST -ne '1') { Main }
