# Inertia CAD Bridge for AutoCAD (Windows, full AutoCAD).
#
# Inertia runs this script with Windows PowerShell 5.1 once per request: one
# JSON request on stdin, one JSON response on stdout. It attaches to the running
# AutoCAD over COM, so nothing has to be installed or trusted inside AutoCAD.
# Reads never change the drawing. Edits are re-validated against the preview's
# fingerprints, shown to the designer in a native Yes/No dialog, and grouped in
# one Undo mark. There is deliberately no way to send AutoCAD commands, LISP or
# scripts through this bridge.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$BridgeVersion = '1.0.0'
$Protocol = 1
$DefaultLimit = 100
$MaxLimit = 500
$MaxScan = 5000
$MaxOperations = 50
$MaxTargets = 500
# Objects of a block definition read into an erase fingerprint; each costs a few COM calls.
$MaxBlockDigestObjects = 500
$MaxCoordinate = 1e9
$InteropVersion = 1

$InsUnits = @{ 0 = 'unitless'; 1 = 'in'; 2 = 'ft'; 3 = 'mi'; 4 = 'mm'; 5 = 'cm'; 6 = 'm'; 7 = 'km'; 8 = 'microinch'; 9 = 'mil'; 10 = 'yd'; 14 = 'dm' }
$ShortTypes = @{
  AcDbLine = 'LINE'; AcDbPolyline = 'LWPOLYLINE'; AcDb2dPolyline = 'POLYLINE'; AcDb3dPolyline = 'POLYLINE'
  AcDbCircle = 'CIRCLE'; AcDbArc = 'ARC'; AcDbEllipse = 'ELLIPSE'; AcDbSpline = 'SPLINE'; AcDbPoint = 'POINT'
  AcDbText = 'TEXT'; AcDbMText = 'MTEXT'; AcDbBlockReference = 'INSERT'; AcDbMInsertBlock = 'INSERT'
  AcDbHatch = 'HATCH'; AcDbLeader = 'LEADER'; AcDbMLeader = 'MULTILEADER'; AcDbRasterImage = 'IMAGE'
  AcDbViewport = 'VIEWPORT'; AcDbAttributeDefinition = 'ATTDEF'; AcDbXline = 'XLINE'; AcDbRay = 'RAY'
  AcDbTable = 'ACAD_TABLE'; AcDbWipeout = 'WIPEOUT'; AcDbSolid = 'SOLID'; AcDb3dSolid = '3DSOLID'
  AcDbRegion = 'REGION'; AcDbFace = '3DFACE'
}

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

function Initialize-Interop {
  if ($null -ne ('InertiaCad.MessageFilter' -as [type])) { return }
  $base = $env:LOCALAPPDATA
  if ([string]::IsNullOrEmpty($base)) { $base = [System.IO.Path]::GetTempPath() }
  $folder = Join-Path $base 'InertiaCad'
  $dll = Join-Path $folder ("interop-$InteropVersion.dll")
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

function Request-Approval([string]$Message) {
  Add-Type -AssemblyName System.Windows.Forms
  # Inertia starts this process hidden, and Windows applies that to the first window
  # a process shows. Spend it on a throwaway form so the dialog is visible.
  $spent = New-Object System.Windows.Forms.Form
  $spent.ShowInTaskbar = $false
  $spent.Opacity = 0
  $spent.Show()
  $spent.Close()
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = 'CenterScreen'
  $owner.FormBorderStyle = 'None'
  $owner.Opacity = 0
  $owner.Size = New-Object System.Drawing.Size 1, 1
  $owner.Show()
  $owner.Activate()
  try {
    $answer = [System.Windows.Forms.MessageBox]::Show($owner, $Message, 'Inertia - approve AutoCAD edit', 'YesNo', 'Question', 'Button2')
    return $answer -eq [System.Windows.Forms.DialogResult]::Yes
  } finally {
    $owner.Close()
  }
}

# --- Small helpers ------------------------------------------------------

function Get-Rounded($Value, [int]$Digits = 4) {
  if ($null -eq $Value) { return $null }
  return [Math]::Round([double]$Value, $Digits)
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
  if ($ObjectName -like '*Dimension') { return 'DIMENSION' }
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
      [double]::IsNaN($number) -or [double]::IsInfinity($number) -or [Math]::Abs($number) -gt $MaxCoordinate) {
      Fail 'INVALID_REQUEST' "$Name must contain finite numbers."
    }
    $result[$i] = $number
  }
  return , $result
}

# --- Documents ----------------------------------------------------------

function Get-DocumentId($Doc) {
  $full = [string]$Doc.FullName
  if ([string]::IsNullOrEmpty($full)) { return 'acad:' + [string]$Doc.Name }
  return 'acad:' + $full
}

function Get-ActiveDocumentName($Acad) {
  try { return [string]$Acad.ActiveDocument.Name } catch { return $null }
}

function Get-Documents($Acad, $Params) {
  $active = Get-ActiveDocumentName $Acad
  $list = New-Object System.Collections.ArrayList
  foreach ($doc in $Acad.Documents) {
    $units = $null
    try { $units = $InsUnits[[int]$doc.GetVariable('INSUNITS')] } catch { }
    $full = [string]$doc.FullName
    [void]$list.Add([ordered]@{
        documentId   = Get-DocumentId $doc
        app          = 'autocad'
        name         = [string]$doc.Name
        path         = $(if ([string]::IsNullOrEmpty($full)) { $null } else { $full })
        modified     = -not [bool]$doc.Saved
        active       = ([string]$doc.Name -eq $active)
        readOnly     = [bool]$doc.ReadOnly
        displayUnits = $units
        activeLayout = $(try { [string]$doc.ActiveLayout.Name } catch { $null })
      })
  }
  return [ordered]@{ documents = $list.ToArray() }
}

function Resolve-Document($Acad, [string]$DocumentId, [switch]$RequireActive) {
  foreach ($doc in $Acad.Documents) {
    if ((Get-DocumentId $doc) -eq $DocumentId) {
      if ($RequireActive -and ([string]$doc.Name -ne (Get-ActiveDocumentName $Acad))) {
        Fail 'INACTIVE_DOCUMENT' 'Switch AutoCAD to this drawing''s tab, then try again.'
      }
      return $doc
    }
  }
  Fail 'DOCUMENT_NOT_FOUND' 'That drawing is no longer open in AutoCAD. Call cad_status for current documents.'
}

function Get-LayoutMap($Doc) {
  $map = @{}
  foreach ($layout in $Doc.Layouts) {
    $map[[string]$layout.Block.ObjectID] = [string]$layout.Name
  }
  return $map
}

# --- Entities -----------------------------------------------------------

function Get-EntityRow($Entity, $LayoutMap) {
  $objectName = [string]$Entity.ObjectName
  $row = [ordered]@{ handle = [string]$Entity.Handle; type = (Get-ShortType $objectName); layer = [string]$Entity.Layer }
  try { $row.color = [int]$Entity.Color } catch { }
  $owner = [string]$Entity.OwnerID
  if ($LayoutMap.ContainsKey($owner)) { $row.layout = $LayoutMap[$owner] } else { $row.nested = $true }
  try {
    switch -Wildcard ($objectName) {
      'AcDbLine' { $row.start = Get-Point $Entity.StartPoint; $row.end = Get-Point $Entity.EndPoint; $row.length = Get-Rounded $Entity.Length }
      'AcDbPolyline' {
        $row.closed = [bool]$Entity.Closed
        $row.length = Get-Rounded $Entity.Length
        $coordinates = @($Entity.Coordinates)
        $row.vertexCount = [int]($coordinates.Count / 2)
        if ($row.vertexCount -le 50) {
          $vertices = New-Object System.Collections.ArrayList
          for ($i = 0; $i + 1 -lt $coordinates.Count; $i += 2) { [void]$vertices.Add(@((Get-Rounded $coordinates[$i]), (Get-Rounded $coordinates[$i + 1]))) }
          $row.vertices = $vertices.ToArray()
        }
        if ($row.closed) { $row.area = Get-Rounded $Entity.Area }
      }
      'AcDbCircle' { $row.center = Get-Point $Entity.Center; $row.radius = Get-Rounded $Entity.Radius }
      'AcDbArc' {
        $row.center = Get-Point $Entity.Center; $row.radius = Get-Rounded $Entity.Radius
        $row.startAngleDeg = Get-Rounded ([double]$Entity.StartAngle * 180 / [Math]::PI) 3
        $row.endAngleDeg = Get-Rounded ([double]$Entity.EndAngle * 180 / [Math]::PI) 3
      }
      'AcDbText' { $row.text = Limit-Text $Entity.TextString; $row.position = Get-Point $Entity.InsertionPoint; $row.height = Get-Rounded $Entity.Height }
      'AcDbMText' { $row.text = Limit-Text $Entity.TextString; $row.position = Get-Point $Entity.InsertionPoint; $row.height = Get-Rounded $Entity.Height }
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
      '*Dimension' { $row.measurement = Get-Rounded $Entity.Measurement; $override = [string]$Entity.TextOverride; if ($override) { $row.textOverride = Limit-Text $override 200 } }
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
  for ($i = 0; $i -lt [Math]::Min($count, $limit); $i++) { [void]$items.Add((Get-EntityRow $set.Item($i) $layoutMap)) }
  return [ordered]@{
    documentId = Get-DocumentId $doc
    units      = $(try { $InsUnits[[int]$doc.GetVariable('INSUNITS')] } catch { $null })
    total      = $count
    truncated  = $count -gt $limit
    items      = $items.ToArray()
  }
}

function Select-Entities($Doc, [string[]]$Types, [string]$Layer, [string]$Layout) {
  $codes = New-Object 'System.Collections.Generic.List[int16]'
  $values = New-Object 'System.Collections.Generic.List[object]'
  if ($Types.Count -gt 0) { $codes.Add(0); $values.Add(($Types -join ',')) }
  if ($Layer) { $codes.Add(8); $values.Add($Layer) }
  if ($Layout -and $Layout -ne '*') { $codes.Add(410); $values.Add($Layout) }
  $set = $Doc.SelectionSets.Add('INERTIACAD' + [guid]::NewGuid().ToString('N').Substring(0, 12))
  $missing = [System.Type]::Missing
  if ($codes.Count -gt 0) {
    $set.Select(5, $missing, $missing, [int16[]]$codes.ToArray(), [object[]]$values.ToArray())
  } else {
    $set.Select(5, $missing, $missing, $missing, $missing)
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
  $layoutMap = Get-LayoutMap $doc
  $set = Select-Entities $doc $types ([string]$Params.layer) $layout
  try {
    $count = [int]$set.Count
    $items = New-Object System.Collections.ArrayList
    $total = $count
    $capped = $false
    if ($null -eq $needle) {
      for ($i = $offset; $i -lt [Math]::Min($count, $offset + $limit); $i++) { [void]$items.Add((Get-EntityRow $set.Item($i) $layoutMap)) }
    } else {
      $total = 0
      for ($i = 0; $i -lt $count; $i++) {
        if ($i -ge $MaxScan) { $capped = $true; break }
        $entity = $set.Item($i)
        $haystack = ''
        try { $haystack = [string]$entity.TextString } catch { }
        try { if ([bool]$entity.HasAttributes) { foreach ($attribute in @($entity.GetAttributes())) { $haystack += ' ' + [string]$attribute.TextString } } } catch { }
        try { $haystack += ' ' + [string]$entity.EffectiveName } catch { }
        if (-not $haystack.ToLowerInvariant().Contains($needle)) { continue }
        if ($total -ge $offset -and $items.Count -lt $limit) { [void]$items.Add((Get-EntityRow $entity $layoutMap)) }
        $total++
      }
    }
    $result = [ordered]@{
      documentId = Get-DocumentId $doc
      units      = $(try { $InsUnits[[int]$doc.GetVariable('INSUNITS')] } catch { $null })
      layout     = $layout
      total      = $total
      items      = $items.ToArray()
    }
    if ($offset + $limit -lt $total) { $result.nextCursor = [string]($offset + $limit) }
    if ($capped) { $result.scanCapped = $true }
    return $result
  } finally {
    Remove-SelectionSet $set
  }
}

function Get-Capture($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId) -RequireActive
  [void][InertiaCad.Window]::SetProcessDPIAware()
  $handle = [IntPtr][long]$Acad.HWND
  if ([InertiaCad.Window]::IsIconic($handle)) { Fail 'CAPTURE_FAILED' 'AutoCAD is minimized. Restore its window and try again.' }
  $bitmap = [InertiaCad.Window]::Capture($handle)
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
  return [ordered]@{
    documentId = Get-DocumentId $doc
    width      = $width
    height     = $height
    pngBase64  = $data
    scene      = $(try { [string]$doc.ActiveLayout.Name } catch { $null })
  }
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
  foreach ($layer in $Doc.Layers) { if ([string]$layer.Name -ieq $Name) { return $layer } }
  return $null
}

function Get-Label($Entity) {
  return "$(Get-ShortType ([string]$Entity.ObjectName)) $([string]$Entity.Handle)"
}

function Get-WritableEntity($Doc, [string]$Handle, $LayoutMap, $Plan) {
  try { $entity = $Doc.HandleToObject($Handle) } catch { Fail 'TARGET_NOT_FOUND' "No object with handle $Handle in this drawing. Read the selection again." }
  if (-not $LayoutMap.ContainsKey([string]$entity.OwnerID)) {
    Fail 'NESTED_TARGET' "$(Get-Label $entity) is inside a block definition; editing it would change every insert of that block. Pick top-level objects."
  }
  $layer = Get-Layer $Doc ([string]$entity.Layer)
  if ($null -ne $layer -and [bool]$layer.Lock) { Fail 'LOCKED' "$(Get-Label $entity) is on locked layer $([string]$entity.Layer). Unlock it in AutoCAD first." }
  $Plan.fingerprints['entity:' + $Handle] = Get-Fingerprint $entity
  return $entity
}

function Add-Change($Plan, [string]$Op, [string]$Target, [string]$Field, $Before, $After) {
  [void]$Plan.changes.Add([ordered]@{ op = $Op; target = $Target; field = $Field; before = $Before; after = $After })
}

function New-Plan($Acad, $Doc, $Operations) {
  $operations = @($Operations)
  if ($operations.Count -eq 0) { Fail 'INVALID_REQUEST' 'Give at least one operation.' }
  if ($operations.Count -gt $MaxOperations) { Fail 'INVALID_REQUEST' "At most $MaxOperations operations per change." }
  $plan = @{
    changes      = New-Object System.Collections.ArrayList
    fingerprints = [ordered]@{}
    steps        = New-Object System.Collections.ArrayList
    warnings     = New-Object System.Collections.ArrayList
  }
  $layoutMap = Get-LayoutMap $Doc
  $newLayers = @{}
  # Layers as earlier operations in this batch leave them, so a later one is never skipped as a no-op.
  $projectedLayers = @{}
  foreach ($op in $operations) {
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
          Add-Change $plan $kind (Get-Label $entity) 'position' $null ("moved by " + (($vector | ForEach-Object { Get-Rounded $_ }) -join ', '))
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity; vector = $vector })
        }
      }
      'acad.erase' {
        foreach ($handle in (Get-Targets $op)) {
          $entity = Get-WritableEntity $Doc $handle $layoutMap $plan
          $definition = Get-BlockDefinitionDigest $Doc $entity
          if ($null -ne $definition) { $plan.fingerprints['block:' + $handle] = $definition }
          Add-Change $plan $kind (Get-Label $entity) 'entity' 'present' 'erased'
          [void]$plan.steps.Add(@{ kind = $kind; entity = $entity })
        }
      }
      { @('acad.add_line', 'acad.add_polyline', 'acad.add_circle', 'acad.add_text') -contains $_ } {
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
          }
          'acad.add_polyline' {
            $points = @($op.points)
            if ($points.Count -lt 2 -or $points.Count -gt 1000) { Fail 'INVALID_REQUEST' 'points needs 2 to 1000 [x, y] pairs.' }
            $flat = New-Object 'double[]' ($points.Count * 2)
            for ($i = 0; $i -lt $points.Count; $i++) { $point = Get-Coordinate $points[$i] "points[$i]"; $flat[2 * $i] = $point[0]; $flat[2 * $i + 1] = $point[1] }
            $step.coordinates = $flat; $step.closed = ($op.closed -eq $true)
            $summary = "polyline with $($points.Count) vertices$(if ($step.closed) { ', closed' })"
          }
          'acad.add_circle' {
            $step.center = Get-Coordinate $op.center 'center'; $step.radius = [double]$op.radius
            if (-not ($step.radius -gt 0 -and $step.radius -lt $MaxCoordinate)) { Fail 'INVALID_REQUEST' 'radius must be greater than 0.' }
            $summary = "circle r=$(Get-Rounded $step.radius) at $(($step.center | ForEach-Object { Get-Rounded $_ }) -join ', ')"
          }
          'acad.add_text' {
            $step.position = Get-Coordinate $op.position 'position'; $step.height = [double]$op.height; $step.text = [string]$op.text
            if (-not ($step.height -gt 0 -and $step.height -lt $MaxCoordinate)) { Fail 'INVALID_REQUEST' 'height must be greater than 0.' }
            if ([string]::IsNullOrEmpty($step.text)) { Fail 'INVALID_REQUEST' 'text must not be empty.' }
            $step.rotation = 0.0
            if ($null -ne $op.rotationDeg) { $step.rotation = [double]$op.rotationDeg * [Math]::PI / 180 }
            $summary = "text `"$(Limit-Text $step.text 60)`""
          }
        }
        $where = 'model space'
        if ($layer) { $where += " on layer $layer" }
        Add-Change $plan $kind "new $($kind.Substring(9))" 'geometry' $null "$summary, $where"
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
    'acad.erase' { $Step.entity.Delete() }
    default {
      $space = $Doc.ModelSpace
      switch ($Step.kind) {
        'acad.add_line' { $entity = $space.AddLine($Step.start, $Step.end) }
        'acad.add_polyline' { $entity = $space.AddLightWeightPolyline($Step.coordinates) }
        'acad.add_circle' { $entity = $space.AddCircle($Step.center, $Step.radius) }
        'acad.add_text' { $entity = $space.AddText($Step.text, $Step.position, $Step.height) }
      }
      # A step either completes or leaves nothing behind, so a failure in the first step changed nothing.
      try {
        if ($Step.kind -eq 'acad.add_polyline' -and $Step.closed) { $entity.Closed = $true }
        if ($Step.kind -eq 'acad.add_text' -and $Step.rotation -ne 0) { $entity.Rotation = $Step.rotation }
        if ($Step.layer) { $entity.Layer = (Get-Layer $Doc $Step.layer).Name }
      } catch { Undo-Creation $entity; throw }
      [void]$Created.Add([ordered]@{ handle = [string]$entity.Handle; type = (Get-ShortType ([string]$entity.ObjectName)) })
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
  $plan = New-Plan $Acad $doc $Params.operations
  return [ordered]@{
    documentId   = Get-DocumentId $doc
    documentName = [string]$doc.Name
    changes      = $plan.changes.ToArray()
    fingerprints = $plan.fingerprints
    warnings     = @($plan.warnings | Select-Object -Unique)
  }
}

function Invoke-Apply($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId) -RequireActive
  $stale = Get-StaleKeys $Params.expectedFingerprints (New-Plan $Acad $doc $Params.operations).fingerprints
  if ($stale.Count -gt 0) { Fail 'TARGET_CHANGED' "The drawing changed since the preview ($((@($stale) | Select-Object -First 5) -join ', ')). Preview the change again." }
  if (-not (Request-Approval ([string]$Params.approvalMessage))) {
    return [ordered]@{ documentId = Get-DocumentId $doc; status = 'rejected' }
  }
  $doc = Resolve-Document $Acad ([string]$Params.documentId) -RequireActive
  $plan = New-Plan $Acad $doc $Params.operations
  $stale = Get-StaleKeys $Params.expectedFingerprints $plan.fingerprints
  if ($stale.Count -gt 0) { Fail 'TARGET_CHANGED' 'The drawing changed while the approval dialog was open. Preview again.' }
  $created = New-Object System.Collections.ArrayList
  $done = 0
  $script:StepLeftChanges = $false
  $doc.StartUndoMark()
  try {
    foreach ($step in $plan.steps) { Invoke-Step $doc $step $created; $done++ }
  } catch {
    $shape = Get-ErrorShape $_
    $doc.EndUndoMark()
    if ($done -eq 0 -and -not $script:StepLeftChanges) { Fail 'APPLY_FAILED' "AutoCAD refused the edit, so nothing was changed: $($shape.message)" }
    Fail 'PARTIALLY_APPLIED' "AutoCAD stopped after $done of $($plan.steps.Count) steps: $($shape.message). One Undo in AutoCAD reverts the steps that ran."
  }
  $doc.EndUndoMark()
  return [ordered]@{
    documentId = Get-DocumentId $doc
    status     = 'applied'
    changes    = $plan.changes.ToArray()
    created    = $created.ToArray()
  }
}

function Save-Copy($Acad, $Params) {
  $doc = Resolve-Document $Acad ([string]$Params.documentId)
  $path = [string]$Params.path
  if ($path -notmatch '\.dwg$') { Fail 'INVALID_REQUEST' 'The copy must be a .dwg file.' }
  if (Test-Path -LiteralPath $path) { Fail 'ALREADY_EXISTS' 'A file already exists at that path. Pick a new name; copies never overwrite.' }
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $path) -PathType Container)) { Fail 'INVALID_REQUEST' 'The destination folder does not exist.' }
  $source = [string]$doc.FullName
  if ([string]::IsNullOrEmpty($source) -or [int]$doc.GetVariable('DWGTITLED') -ne 1) {
    Fail 'UNTITLED_DOCUMENT' 'This drawing has never been saved. Save it once in AutoCAD, then ask for the copy again.'
  }
  # AutoCAD's SAVE-to-another-name can mark the open drawing as saved even though
  # its own file was not written, so a drawing with unsaved changes is refused
  # instead: the designer decides when her working file is written.
  if (-not [bool]$doc.Saved) {
    Fail 'UNSAVED_CHANGES' 'The drawing has unsaved changes. Save it in AutoCAD (Ctrl+S) or undo them, then ask for the copy again.'
  }
  Copy-Item -LiteralPath $source -Destination $path
  return [ordered]@{ documentId = Get-DocumentId $doc; path = $path; bytes = (Get-Item -LiteralPath $path).Length; originalPath = $source }
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
}

# --- Entry point --------------------------------------------------------

function Invoke-Request([string]$Raw, [scriptblock]$Connect) {
  $response = [ordered]@{ v = $Protocol; id = $null; ok = $false }
  try {
    $request = $Raw | ConvertFrom-Json
    $response.id = $request.id
    $command = $Methods[[string]$request.method]
    if ($null -eq $command) { Fail 'UNSUPPORTED_OPERATION' "Unknown bridge method `"$($request.method)`"." }
    $acad = & $Connect
    $params = $request.params
    if ($null -eq $params) { $params = New-Object PSObject }
    $response.result = & $command $acad $params
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
    $json = Invoke-Request $raw { Initialize-Interop | Out-Null; Connect-AutoCAD }
  } finally {
    if ($null -ne ('InertiaCad.MessageFilter' -as [type])) { [InertiaCad.MessageFilter]::Revoke() }
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $output = [Console]::OpenStandardOutput()
  $output.Write($bytes, 0, $bytes.Length)
  $output.Flush()
}

if ($env:INERTIA_CAD_BRIDGE_TEST -ne '1') { Main }
