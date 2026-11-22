# Exercises the AutoCAD bridge against a small fake of AutoCAD's COM objects.
# Run with: pwsh -NoProfile -File src/server/cad/hosts/autocad/InertiaCadBridge.Tests.ps1
# (Windows PowerShell 5.1 works too.) Real-host behaviour still needs AutoCAD.
$ErrorActionPreference = 'Stop'
$env:INERTIA_CAD_BRIDGE_TEST = '1'
. (Join-Path $PSScriptRoot 'InertiaCadBridge.ps1')

$script:Failures = 0
# PowerShell 7 writes whole doubles as 2.0 where 5.1 writes 2, so numbers compare by value.
function ConvertTo-Comparable($Value) {
  return (ConvertTo-Json -InputObject $Value -Depth 8 -Compress) -replace '(?<=\d)\.0+(?=[,\]\}]|$)', ''
}
function Assert-Equal($Expected, $Actual, [string]$Message) {
  $left = ConvertTo-Comparable $Expected
  $right = ConvertTo-Comparable $Actual
  if ($left -ne $right) {
    $script:Failures++
    Write-Host "FAIL: $Message`n  expected $left`n  actual   $right"
  }
}

class FakeCollection : System.Collections.IEnumerable {
  [System.Collections.ArrayList]$Items = (New-Object System.Collections.ArrayList)
  [scriptblock]$Factory
  [object]$Owner
  [int]$Enumerations = 0
  FakeCollection() { Add-Member -InputObject $this -MemberType ScriptProperty -Name Count -Value { $this.Items.Count } }
  [object] Add([string]$Name) { $item = & $this.Factory $Name $this.Owner; [void]$this.Items.Add($item); return $item }
  # Like COM collections: Item takes an index or a case-insensitive name and throws when nothing matches.
  [object] Item([object]$Index) {
    if ($Index -is [int]) { return $this.Items[$Index] }
    foreach ($item in $this.Items) { if ([string]$item.Name -ieq [string]$Index) { return $item } }
    throw "Key not found: $Index"
  }
  [System.Collections.IEnumerator] GetEnumerator() { $this.Enumerations++; return $this.Items.GetEnumerator() }
}

# Enumerable like the real AcadSelectionSet, so PowerShell unrolls it the same way when it is returned.
class FakeSelectionSet : System.Collections.IEnumerable {
  [object]$Doc
  [string]$Name
  [object[]]$Entities = @()
  [int]$Count = 0
  [scriptblock]$Filter
  [object] Item([object]$Index) { return $this.Entities[[int]$Index] }
  [void] Select([int]$Mode, $P1, $P2, $Codes, $Values) {
    if ($this.Doc.FailSelect) { throw 'eInvalidInput' }
    # AutoCAD rejects corner points that are not three-element double arrays, and filter codes that are not shorts.
    if ($Mode -le 1 -and -not ($P1 -is [double[]] -and $P1.Length -eq 3 -and $P2 -is [double[]] -and $P2.Length -eq 3)) { throw 'Invalid argument Point1 in Select' }
    if ($Codes -isnot [System.Reflection.Missing] -and $Codes -isnot [int16[]]) { throw 'Invalid argument FilterType in Select' }
    $this.Entities = @(& $this.Filter $this.Doc $Mode $P1 $P2 $Codes $Values)
    $this.Count = $this.Entities.Count
  }
  [void] Delete() { $this.Doc.DeletedSets++; [void]$this.Doc.SelectionSets.Items.Remove($this) }
  [System.Collections.IEnumerator] GetEnumerator() { return $this.Entities.GetEnumerator() }
}

# A block definition: enumerable like the real AcadBlock, with a real Count.
class FakeBlock : System.Collections.IEnumerable {
  [string]$Name
  [bool]$IsLayout = $false
  [bool]$IsXRef = $false
  [System.Collections.ArrayList]$Items = (New-Object System.Collections.ArrayList)
  [int]$Count = 0
  [object] Item([int]$Index) { return $this.Items[$Index] }
  [void] Add($Entity) { [void]$this.Items.Add($Entity); $this.Count = $this.Items.Count }
  [System.Collections.IEnumerator] GetEnumerator() { return $this.Items.GetEnumerator() }
}

# The block table: enumerable like the real AcadBlocks, and Item takes an index or a case-insensitive name.
# A class method returns its object as is on Windows PowerShell 5.1 and 7; a script method may not.
class FakeBlocks : System.Collections.IEnumerable {
  [System.Collections.ArrayList]$Definitions = (New-Object System.Collections.ArrayList)
  [object] Add([string]$Name) { $block = [FakeBlock]::new(); $block.Name = $Name; [void]$this.Definitions.Add($block); return $block }
  [object] Item([object]$Index) {
    if ($Index -is [int]) { return $this.Definitions[$Index] }
    foreach ($block in $this.Definitions) { if ($block.Name -ieq [string]$Index) { return $block } }
    throw "Unknown block $Index"
  }
  [System.Collections.IEnumerator] GetEnumerator() { return $this.Definitions.GetEnumerator() }
}

function Get-FakeExtent($Entity) {
  $points = New-Object System.Collections.ArrayList
  foreach ($name in 'StartPoint', 'EndPoint', 'InsertionPoint') { if ($null -ne $Entity.$name) { [void]$points.Add(@($Entity.$name)) } }
  if ($null -ne $Entity.Center -and $null -ne $Entity.Radius) {
    $c = $Entity.Center; $r = $Entity.Radius
    [void]$points.Add(@(($c[0] - $r), ($c[1] - $r), $c[2])); [void]$points.Add(@(($c[0] + $r), ($c[1] + $r), $c[2]))
  }
  if ($null -ne $Entity.Coordinates -and $Entity.ObjectName -eq 'AcDbPolyline') {
    for ($i = 0; $i + 1 -lt $Entity.Coordinates.Count; $i += 2) { [void]$points.Add(@($Entity.Coordinates[$i], $Entity.Coordinates[$i + 1], 0.0)) }
  }
  if ($points.Count -eq 0) { return $null }
  $min = New-Object 'double[]' 3; $max = New-Object 'double[]' 3
  for ($k = 0; $k -lt 3; $k++) {
    $min[$k] = ($points | ForEach-Object { $_[$k] } | Measure-Object -Minimum).Minimum
    $max[$k] = ($points | ForEach-Object { $_[$k] } | Measure-Object -Maximum).Maximum
  }
  return @{ min = $min; max = $max }
}

function Assert-FakePoint($Point, [string]$Name) {
  if (-not ($Point -is [double[]] -and $Point.Length -eq 3)) { throw "Invalid argument $Name" }
}

$FakeBaseProperties = @('Handle', 'ObjectName', 'Layer', 'Color', 'OwnerID', 'Deleted', 'Doc', 'Linetype', 'Lineweight')

function New-FakeEntity([string]$Handle, [string]$ObjectName, [string]$Layer, [string]$Owner, [hashtable]$Properties = @{}) {
  $entity = [pscustomobject]@{ Handle = $Handle; ObjectName = $ObjectName; Layer = $Layer; Color = 256; OwnerID = $Owner; Deleted = $false; Doc = $null; Linetype = 'ByLayer'; Lineweight = -1 }
  foreach ($key in $Properties.Keys) { Add-Member -InputObject $entity -NotePropertyName $key -NotePropertyValue $Properties[$key] }
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Move -Value {
    param($From, $To)
    foreach ($name in 'StartPoint', 'EndPoint', 'InsertionPoint', 'Center') {
      if ($null -ne $this.$name) { $point = $this.$name; $this.$name = @(($point[0] + $To[0] - $From[0]), ($point[1] + $To[1] - $From[1]), ($point[2] + $To[2] - $From[2])) }
    }
  }
  # Like AcadEntity.Rotate: radians about a base point given as a three-element double array; Rotation reads back in [0, 2pi).
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Rotate -Value {
    param($Base, $Angle)
    if (-not ($Base -is [double[]] -and $Base.Length -eq 3)) { throw 'Invalid argument BasePoint in Rotate' }
    $cos = [Math]::Cos($Angle); $sin = [Math]::Sin($Angle)
    foreach ($name in 'StartPoint', 'EndPoint', 'InsertionPoint', 'Center') {
      if ($null -ne $this.$name) {
        $point = $this.$name; $dx = $point[0] - $Base[0]; $dy = $point[1] - $Base[1]
        $this.$name = @(($Base[0] + $dx * $cos - $dy * $sin), ($Base[1] + $dx * $sin + $dy * $cos), $point[2])
      }
    }
    if ($null -ne $this.PSObject.Properties['Rotation']) { $this.Rotation = (($this.Rotation + $Angle) % (2 * [Math]::PI) + 2 * [Math]::PI) % (2 * [Math]::PI) }
  }
  # Like AcadEntity.Copy: a new object in the same place with the same properties.
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Copy -Value {
    $properties = @{}
    foreach ($property in $this.PSObject.Properties) {
      if ($property.MemberType -ne 'NoteProperty' -or $FakeBaseProperties -contains $property.Name) { continue }
      $value = $property.Value
      if ($value -is [System.Array]) { $value = [double[]]@($value) }
      $properties[$property.Name] = $value
    }
    $this.Doc.NextHandle++
    $copy = New-FakeEntity ('{0:X}' -f $this.Doc.NextHandle) $this.ObjectName $this.Layer $this.OwnerID $properties
    $copy.Color = $this.Color; $copy.Linetype = $this.Linetype; $copy.Lineweight = $this.Lineweight
    return Add-FakeEntity $this.Doc $copy
  }
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Mirror -Value {
    param($P1, $P2)
    Assert-FakePoint $P1 'Point1'; Assert-FakePoint $P2 'Point2'
    $copy = $this.Copy()
    foreach ($name in 'StartPoint', 'EndPoint', 'InsertionPoint', 'Center') {
      if ($null -ne $copy.$name) { $mirrored = Get-Mirrored $copy.$name $P1 $P2; $copy.$name = @($mirrored[0], $mirrored[1], $copy.$name[2]) }
    }
    return $copy
  }
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name ScaleEntity -Value {
    param($Base, $Factor)
    Assert-FakePoint $Base 'BasePoint'
    foreach ($name in 'StartPoint', 'EndPoint', 'InsertionPoint', 'Center') {
      if ($null -ne $this.$name) { $point = $this.$name; $this.$name = @(0..2 | ForEach-Object { $Base[$_] + ($point[$_] - $Base[$_]) * $Factor }) }
    }
    # PSObject.Properties, because PowerShell 7 gives every object an intrinsic Length of 1.
    foreach ($name in 'Radius', 'Height', 'Length') { if ($null -ne $this.PSObject.Properties[$name]) { $this.$name = $this.$name * $Factor } }
  }
  # Lines offset to their left for a positive distance; circles and arcs grow.
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Offset -Value {
    param($Distance)
    $copy = $this.Copy()
    switch ($this.ObjectName) {
      'AcDbLine' {
        $dx = $this.EndPoint[0] - $this.StartPoint[0]; $dy = $this.EndPoint[1] - $this.StartPoint[1]; $length = [Math]::Sqrt($dx * $dx + $dy * $dy)
        $nx = -$dy / $length * $Distance; $ny = $dx / $length * $Distance
        $copy.StartPoint = @(($this.StartPoint[0] + $nx), ($this.StartPoint[1] + $ny), 0.0); $copy.EndPoint = @(($this.EndPoint[0] + $nx), ($this.EndPoint[1] + $ny), 0.0)
      }
      { @('AcDbCircle', 'AcDbArc') -contains $_ } {
        if ($this.Radius + $Distance -le 0) { $copy.Delete(); throw 'eInvalidInput' }
        $copy.Radius = $this.Radius + $Distance
      }
      default { $copy.Delete(); throw 'eNotImplemented' }
    }
    return , @($copy)
  }
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Delete -Value { $this.Deleted = $true; if ($null -ne $this.Doc) { $this.Doc.Dbmod = $this.Doc.Dbmod -bor 1 } }
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name GetBoundingBox -Value {
    param([ref]$Min, [ref]$Max)
    $extent = Get-FakeExtent $this
    if ($null -eq $extent) { throw 'eNotApplicable' }
    $Min.Value = $extent.min; $Max.Value = $extent.max
  }
  return $entity
}

function Add-FakeEntity($Doc, $Entity) {
  $Entity.Doc = $Doc
  $Doc.Registry[$Entity.Handle] = $Entity
  return $Entity
}

# Like AcadAcCmColor: EntityColor carries the AcColorMethod (0xC0 ByLayer, 0xC2 RGB, 0xC3 ACI) in its high byte.
function New-FakeTrueColor([int]$Method, [int]$Value) {
  $rgb = $(if ($Method -eq 0xC2) { $Value } else { 0 })
  return [pscustomobject]@{
    ColorMethod = $Method; EntityColor = [int](($Method - 256) * 16777216 + $Value)
    ColorIndex = $(if ($Method -eq 0xC3) { $Value } else { 256 })
    Red = ($rgb -shr 16) -band 0xFF; Green = ($rgb -shr 8) -band 0xFF; Blue = $rgb -band 0xFF
  }
}

function New-FakeAutoCAD([string]$Name = 'Plan.dwg', [switch]$Empty) {
  $registry = @{}
  $layers = [FakeCollection]::new()
  $layers.Factory = {
    param($Name)
    # Lineweight is ACAD_LWEIGHT: hundredths of a millimetre, or -1 ByLayer, -2 ByBlock, -3 Default.
    $layer = [pscustomobject]@{ Name = $Name; Lock = $false; Color = 7; LayerOn = $true; Freeze = $false; Linetype = 'Continuous'; TrueColor = (New-FakeTrueColor 0xC3 7); Lineweight = -3; XData = $null }
    Add-Member -InputObject $layer -MemberType ScriptMethod -Name GetXData -Value {
      param([string]$App, [ref]$Types, [ref]$Values)
      if ($App -eq 'AcCmTransparency' -and $null -ne $this.XData) { $Types.Value = [int16[]]@(1001, 1071); $Values.Value = [object[]]@($App, $this.XData) }
    }
    return $layer
  }
  [void]$layers.Add('0')
  $wall = $layers.Add('A-WALL'); $wall.TrueColor = New-FakeTrueColor 0xC2 0x804020; $wall.Lineweight = 50; $wall.XData = 0x0200007F
  $anno = $layers.Add('A-ANNO'); $anno.Lineweight = 18; $anno.XData = 0x0100002A
  $locked = $layers.Add('LOCKED'); $locked.Lock = $true
  $textStyles = [FakeCollection]::new()
  $textStyles.Factory = {
    param($Name)
    $style = [pscustomobject]@{ Name = $Name; fontFile = 'txt.shx'; Height = 0.0; Width = 1.0; TypeFace = ''; FontCalls = 0; OnFont = $null }
    Add-Member -InputObject $style -MemberType ScriptMethod -Name GetFont -Value {
      param([ref]$TypeFace, [ref]$Bold, [ref]$Italic, [ref]$Charset, [ref]$PitchAndFamily)
      $this.FontCalls++
      if ($null -ne $this.OnFont) { & $this.OnFont }
      $TypeFace.Value = $this.TypeFace; $Bold.Value = $false; $Italic.Value = $false; $Charset.Value = 0; $PitchAndFamily.Value = 34
    }
    return $style
  }
  $standardText = $textStyles.Add('Standard'); $standardText.fontFile = 'arial.ttf'; $standardText.TypeFace = 'Arial'
  $romans = $textStyles.Add('ROMANS'); $romans.fontFile = 'romans.shx'; $romans.Height = 2.5; $romans.Width = 0.8
  [void]$textStyles.Add(''); [void]$textStyles.Add('SITE|NOTES')
  $dimStyles = [FakeCollection]::new()
  $dimStyles.Factory = { param($Name) [pscustomobject]@{ Name = $Name } }
  foreach ($dimName in 'Standard', 'ISO-25', 'A-1to50', 'SITE|ISO-25') { [void]$dimStyles.Add($dimName) }
  $paperModel = [pscustomobject]@{ Name = 'Model'; Block = [pscustomobject]@{ ObjectID = 1 }; CanonicalMediaName = 'Letter'; ConfigName = 'None'; StyleSheet = '' }
  $paperA1 = [pscustomobject]@{ Name = 'A1'; Block = [pscustomobject]@{ ObjectID = 2 }; CanonicalMediaName = 'ISO_full_bleed_A1_(841.00_x_594.00_MM)'; ConfigName = 'DWG To PDF.pc3'; StyleSheet = 'monochrome.ctb' }

  $blocks = [FakeBlocks]::new()
  foreach ($blockName in '*Model_Space', '*Paper_Space', '*Paper_Space0', '*U12', '*D3', 'TITLE', 'DOOR', 'SITE', 'SITE|TREE', 'A1-LAYOUT') {
    $block = $blocks.Add($blockName)
    $block.IsLayout = ($blockName -like '*_Space*' -or $blockName -eq 'A1-LAYOUT')
    $block.IsXRef = ($blockName -eq 'SITE')
  }

  $doc = [pscustomobject]@{
    Name = $Name; FullName = ''; Saved = $true; ReadOnly = $false; Layers = $layers; TextStyles = $textStyles; DimStyles = $dimStyles
    Layouts = @($paperModel, $paperA1)
    Blocks = $blocks
    Undo = (New-Object System.Collections.ArrayList); Registry = $registry; NextHandle = 500; Pickfirst = @(); DeletedSets = 0
    ActiveLayout = [pscustomobject]@{ Name = 'Model' }; Dbmod = 0; PickfirstVar = 1; FailSelect = $false; CmdActive = 0; UndoCtl = 5; FailEndUndo = $false
    ExtMin = @(0.0, 0.0, 0.0); ExtMax = @(1000.0, 500.0, 0.0); SetNames = (New-Object System.Collections.ArrayList); SelectFilter = $null
    ViewCtr = @(5.0, 5.0, 0.0); ViewSize = 20.0; Views = (New-Object System.Collections.ArrayList); Regens = 0
  }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name GetVariable -Value {
    param($Name)
    switch ($Name) {
      'INSUNITS' { 4 } 'LUNITS' { 2 } 'WORLDUCS' { 1 } 'VIEWTWIST' { 0.0 } 'DBMOD' { $this.Dbmod } 'PICKFIRST' { $this.PickfirstVar }
      'CMDACTIVE' { $this.CmdActive } 'UNDOCTL' { $this.UndoCtl } 'VIEWCTR' { , [double[]]$this.ViewCtr } 'VIEWSIZE' { $this.ViewSize }
      'EXTMIN' { , [double[]]$this.ExtMin } 'EXTMAX' { , [double[]]$this.ExtMax }
      'DWGTITLED' { $(if ($this.FullName) { 1 } else { 0 }) }
      'CLAYER' { 'A-WALL' } 'TEXTSTYLE' { 'ROMANS' } 'DIMSTYLE' { 'A-1to50' } 'LTSCALE' { 50.0 }
      'DIMTXT' { 2.5 } 'DIMASZ' { 2.0 } 'DIMSCALE' { 50.0 } 'DIMDEC' { [int16]0 }
      default { throw "Unknown system variable $Name" }
    }
  }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name StartUndoMark -Value { [void]$this.Undo.Add('start') }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name Regen -Value { param($Which) if ($Which -ne 0) { throw 'expected acActiveViewport' }; $this.Regens++ }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name EndUndoMark -Value { [void]$this.Undo.Add('end'); if ($this.FailEndUndo) { throw 'eNotInGroup' } }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name HandleToObject -Value {
    param($Handle)
    $entity = $this.Registry[$Handle]
    if ($null -eq $entity -or $entity.Deleted) { throw 'Unknown handle' }
    return $entity
  }
  $doc.SelectFilter = {
    param($Doc, $Mode, $P1, $P2, $Codes, $Values)
    $all = @($Doc.Registry.Values | Where-Object { -not $_.Deleted -and $_.OwnerID -eq 1 } | Sort-Object Handle)
    if ($Mode -le 1) {
      # Picking from the screen has a tolerance, so AutoCAD can return objects just outside the corners.
      $all = @($all | Where-Object {
          $extent = Get-FakeExtent $_
          if ($null -eq $extent) { return $false }
          $inside = $true
          for ($k = 0; $k -lt 2; $k++) {
            $lo = [Math]::Min($P1[$k], $P2[$k]) - 1; $hi = [Math]::Max($P1[$k], $P2[$k]) + 1
            if ($Mode -eq 0) { if ($extent.min[$k] -lt $lo -or $extent.max[$k] -gt $hi) { $inside = $false } }
            elseif ($extent.max[$k] -lt $lo -or $extent.min[$k] -gt $hi) { $inside = $false }
          }
          $inside
        })
    }
    if ($Codes -is [System.Reflection.Missing]) { return $all }
    for ($i = 0; $i -lt $Codes.Count; $i++) {
      $value = $Values[$i]
      switch ($Codes[$i]) {
        0 { $types = $value -split ','; $all = @($all | Where-Object { $types -contains (Get-ShortType $_.ObjectName) }) }
        8 { $all = @($all | Where-Object { $_.Layer -like $value }) }
      }
    }
    return $all
  }
  $selectionSets = [FakeCollection]::new()
  $selectionSets.Owner = $doc
  $selectionSets.Factory = {
    param($Name, $Doc)
    if (@($Doc.SelectionSets.Items | Where-Object { $_.Name -eq $Name }).Count -gt 0) { throw 'Duplicate key' }
    [void]$Doc.SetNames.Add($Name)
    $set = [FakeSelectionSet]::new()
    $set.Doc = $Doc
    $set.Name = $Name
    $set.Filter = $Doc.SelectFilter
    return , $set
  }
  Add-Member -InputObject $doc -MemberType NoteProperty -Name SelectionSets -Value $selectionSets
  Add-Member -InputObject $doc -MemberType ScriptProperty -Name PickfirstSelectionSet -Value {
    $set = [FakeSelectionSet]::new()
    $set.Doc = $this
    $set.Name = 'PICKFIRST'
    $set.Entities = @($this.Pickfirst | ForEach-Object { $this.Registry[$_] })
    $set.Count = $set.Entities.Count
    return , $set
  }
  $space = [pscustomobject]@{ Doc = $doc }
  Add-Member -InputObject $space -MemberType ScriptProperty -Name Count -Value { @($this.Doc.Registry.Values | Where-Object { -not $_.Deleted -and $_.OwnerID -eq 1 }).Count }
  # New objects take the current color, linetype and lineweight, here a red DASHED 0.30 mm override.
  $addEntity = {
    param($Space, $ObjectName, $Properties)
    $Space.Doc.NextHandle++
    $entity = Add-FakeEntity $Space.Doc (New-FakeEntity ('{0:X}' -f $Space.Doc.NextHandle) $ObjectName '0' 1 $Properties)
    $entity.Color = 1; $entity.Linetype = 'DASHED'; $entity.Lineweight = 30
    return $entity
  }
  Add-Member -InputObject $space -MemberType NoteProperty -Name AddEntity -Value $addEntity
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddLine -Value { param($Start, $End) & $this.AddEntity $this 'AcDbLine' @{ StartPoint = $Start; EndPoint = $End } }
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddCircle -Value { param($Center, $Radius) & $this.AddEntity $this 'AcDbCircle' @{ Center = $Center; Radius = $Radius } }
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddArc -Value {
    param($Center, $Radius, $Start, $End)
    Assert-FakePoint $Center 'Center'
    & $this.AddEntity $this 'AcDbArc' @{ Center = $Center; Radius = $Radius; StartAngle = $Start; EndAngle = $End }
  }
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddLightWeightPolyline -Value {
    param($Coordinates)
    if ($Coordinates -isnot [double[]]) { throw 'Invalid argument VerticesList' }
    & $this.AddEntity $this 'AcDbPolyline' @{ Coordinates = $Coordinates; Closed = $false; Length = 0.0 }
  }
  Add-Member -InputObject $space -MemberType ScriptMethod -Name InsertBlock -Value {
    param($Point, $Name, $X, $Y, $Z, $Rotation)
    Assert-FakePoint $Point 'InsertionPoint'
    $block = $this.Doc.Blocks.Item($Name)
    & $this.AddEntity $this 'AcDbBlockReference' @{ Name = $block.Name; EffectiveName = $block.Name; HasAttributes = $false; InsertionPoint = $Point; Rotation = $Rotation; XScaleFactor = $X; YScaleFactor = $Y; ZScaleFactor = $Z }
  }
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddDimAligned -Value {
    param($P1, $P2, $Text)
    Assert-FakePoint $P1 'ExtLine1Point'; Assert-FakePoint $P2 'ExtLine2Point'; Assert-FakePoint $Text 'TextPosition'
    & $this.AddEntity $this 'AcDbAlignedDimension' @{ ExtLine1Point = $P1; ExtLine2Point = $P2; TextPosition = $Text; TextOverride = ''; Measurement = [Math]::Sqrt([Math]::Pow($P2[0] - $P1[0], 2) + [Math]::Pow($P2[1] - $P1[1], 2)) }
  }
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddDimRotated -Value {
    param($P1, $P2, $Line, $Rotation)
    Assert-FakePoint $P1 'ExtLine1Point'; Assert-FakePoint $P2 'ExtLine2Point'; Assert-FakePoint $Line 'DimLineLocation'
    & $this.AddEntity $this 'AcDbRotatedDimension' @{ TextPosition = $Line; Rotation = $Rotation; TextOverride = ''; Measurement = [Math]::Abs(($P2[0] - $P1[0]) * [Math]::Cos($Rotation) + ($P2[1] - $P1[1]) * [Math]::Sin($Rotation)) }
  }
  # Like AcadHatch: AutoCAD knows only the patterns in its .pat files, and Evaluate needs a closed outer loop.
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddHatch -Value {
    param($PatternType, $PatternName, $Associative)
    if (@('SOLID', 'ANSI31', 'AR-CONC') -notcontains $PatternName) { throw 'eInvalidInput' }
    $hatch = & $this.AddEntity $this 'AcDbHatch' @{ PatternType = $PatternType; PatternName = $PatternName; AssociativeHatch = $Associative; PatternScale = 1.0; PatternAngle = 0.0; Loop = $null; LoopObjects = $null; Area = 0.0 }
    Add-Member -InputObject $hatch -MemberType ScriptMethod -Name AppendOuterLoop -Value {
      param($Objects)
      if ($Objects -isnot [System.Array]) { throw 'Invalid object array' }
      foreach ($object in $Objects) { if ($object.Deleted) { throw 'eWasErased' } }
      $this.Loop = @($Objects | ForEach-Object Handle); $this.LoopObjects = $Objects
    }
    Add-Member -InputObject $hatch -MemberType ScriptMethod -Name Evaluate -Value {
      $objects = @($this.LoopObjects)
      if ($objects.Count -ne 1) { throw 'eInvalidInput' }
      $object = $objects[0]
      switch ($object.ObjectName) {
        'AcDbCircle' { $this.Area = [Math]::PI * $object.Radius * $object.Radius }
        'AcDbPolyline' {
          if (-not $object.Closed) { throw 'eNotClosed' }
          $c = $object.Coordinates; $n = $c.Count / 2; $sum = 0.0
          for ($i = 0; $i -lt $n; $i++) { $j = ($i + 1) % $n; $sum += $c[2 * $i] * $c[2 * $j + 1] - $c[2 * $j] * $c[2 * $i + 1] }
          $this.Area = [Math]::Abs($sum) / 2
        }
        default { throw 'eNotClosed' }
      }
    }
    return $hatch
  }
  Add-Member -InputObject $doc -MemberType NoteProperty -Name ModelSpace -Value $space

  if (-not $Empty) {
    [void](Add-FakeEntity $doc (New-FakeEntity '1A' 'AcDbLine' 'A-WALL' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(1000.0, 0.0, 0.0); Length = 1000.0 }))
    [void](Add-FakeEntity $doc (New-FakeEntity '1B' 'AcDbLine' 'A-WALL' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(0.0, 500.0, 0.0); Length = 500.0 }))
    [void](Add-FakeEntity $doc (New-FakeEntity '2C' 'AcDbText' 'A-ANNO' 1 @{ TextString = 'KITCHEN'; InsertionPoint = @(10.0, 10.0, 0.0); Height = 250.0 }))
    [void](Add-FakeEntity $doc (New-FakeEntity '3D' 'AcDbLine' 'A-WALL' 99 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(1.0, 1.0, 0.0) }))
    [void](Add-FakeEntity $doc (New-FakeEntity '4E' 'AcDbLine' 'LOCKED' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(2.0, 2.0, 0.0) }))
    $attribute = [pscustomobject]@{ TagString = 'REV'; TextString = 'A' }
    $title = New-FakeEntity '5F' 'AcDbBlockReference' '0' 2 @{ Name = 'TITLE'; EffectiveName = 'TITLE'; HasAttributes = $true; InsertionPoint = @(0.0, 0.0, 0.0); Rotation = 0.0; XScaleFactor = 1.0; YScaleFactor = 1.0; ZScaleFactor = 1.0; Attribute = $attribute }
    Add-Member -InputObject $title -MemberType ScriptMethod -Name GetAttributes -Value { , @($this.Attribute) }
    [void](Add-FakeEntity $doc $title)
    $frame = $doc.Blocks.Item('TITLE')
    $frame.Add((New-FakeEntity '6A' 'AcDbLine' '0' 77 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(420.0, 0.0, 0.0) }))
    $frame.Add((New-FakeEntity '6B' 'AcDbText' '0' 77 @{ TextString = 'TITLE'; InsertionPoint = @(10.0, 10.0, 0.0) }))
    $registry['L1'] = [pscustomobject]@{ Handle = 'L1'; ObjectName = 'AcDbLayerTableRecord'; OwnerID = 77; Name = 'A-WALL'; Deleted = $false }
    $doc.Pickfirst = @('1A', '2C', '5F')
  }

  $acad = [pscustomobject]@{ Version = '25.0s (LMS Tech)'; Name = 'AutoCAD'; Documents = @($doc); ActiveDocument = $doc; HWND = 0; ZoomCalls = (New-Object System.Collections.ArrayList) }
  # Like AutoCAD, every zoom pushes the view it leaves onto the history and marks the view changed (DBMOD 16).
  Add-Member -InputObject $acad -MemberType ScriptMethod -Name SetView -Value {
    param([string]$Call, $Center, $Size)
    $d = $this.ActiveDocument
    [void]$this.ZoomCalls.Add($Call)
    if ($Call -ne 'previous') { [void]$d.Views.Add(@($d.ViewCtr, $d.ViewSize)) }
    $d.ViewCtr = $Center; $d.ViewSize = $Size; $d.Dbmod = $d.Dbmod -bor 16
  }
  Add-Member -InputObject $acad -MemberType ScriptMethod -Name ZoomExtents -Value {
    $d = $this.ActiveDocument
    $this.SetView('extents', @((($d.ExtMin[0] + $d.ExtMax[0]) / 2), (($d.ExtMin[1] + $d.ExtMax[1]) / 2), 0.0), ($d.ExtMax[1] - $d.ExtMin[1]))
    # It also recomputes EXTMIN/EXTMAX, which AutoCAD records as a system-variable change.
    $d.Dbmod = $d.Dbmod -bor 4
  }
  Add-Member -InputObject $acad -MemberType ScriptMethod -Name ZoomWindow -Value {
    param($LowerLeft, $UpperRight)
    if (-not ($LowerLeft -is [double[]] -and $LowerLeft.Length -eq 3 -and $UpperRight -is [double[]] -and $UpperRight.Length -eq 3)) { throw 'Invalid argument LowerLeft in ZoomWindow' }
    $this.SetView('window', @((($LowerLeft[0] + $UpperRight[0]) / 2), (($LowerLeft[1] + $UpperRight[1]) / 2), 0.0), ($UpperRight[1] - $LowerLeft[1]))
  }
  Add-Member -InputObject $acad -MemberType ScriptMethod -Name ZoomPrevious -Value {
    $views = $this.ActiveDocument.Views
    $last = $views[$views.Count - 1]
    $views.RemoveAt($views.Count - 1)
    $this.SetView('previous', $last[0], $last[1])
  }
  Add-Member -InputObject $acad -MemberType ScriptMethod -Name Update -Value { }
  return $acad
}

# Holds the apply mutex from another thread, as a second bridge process would.
function Start-LockHolder {
  $acquired = New-Object System.Threading.ManualResetEvent $false
  $release = New-Object System.Threading.ManualResetEvent $false
  $shell = [powershell]::Create().AddScript({
      param($Name, $Acquired, $Release)
      $mutex = New-Object System.Threading.Mutex($false, $Name)
      [void]$mutex.WaitOne()
      [void]$Acquired.Set()
      [void]$Release.WaitOne()
      $mutex.ReleaseMutex()
      $mutex.Dispose()
    }).AddArgument($ApplyMutexName).AddArgument($acquired).AddArgument($release)
  $async = $shell.BeginInvoke()
  [void]$acquired.WaitOne(10000)
  return @{ shell = $shell; async = $async; release = $release }
}

function Stop-LockHolder($Holder) {
  [void]$Holder.release.Set()
  [void]$Holder.shell.EndInvoke($Holder.async)
  $Holder.shell.Dispose()
}

function Invoke-Fake($Acad, [string]$Method, $Params) {
  $raw = ConvertTo-Json -InputObject ([ordered]@{ id = 'r1'; method = $Method; params = $Params }) -Depth 10 -Compress
  $json = Invoke-Request $raw { $Acad }.GetNewClosure()
  return $json | ConvertFrom-Json
}

function Get-FakeState($Acad) {
  return @(foreach ($d in $Acad.Documents) {
      [ordered]@{
        deleted      = @($d.Registry.Values | Where-Object Deleted | ForEach-Object Handle | Sort-Object)
        fingerprints = @($d.Registry.Keys | Sort-Object | ForEach-Object { Get-Fingerprint $d.Registry[$_] })
        undo         = $d.Undo.Count
        # Reads may zoom for a capture, which sets only the window and view bits.
        dbmod        = $d.Dbmod -band -bnot 24
        view         = "$($d.ViewCtr -join ',') @ $($d.ViewSize)"
        saved        = $d.Saved
        layers       = @($d.Layers.Items | ForEach-Object { "$($_.Name):$($_.Lock)" })
        sets         = @($d.SelectionSets.Items | ForEach-Object Name | Where-Object { $_ -like 'INERTIACAD*' })
      }
    })
}

# Every read goes through here, so a read that erases, edits or leaks anything fails loudly.
function Invoke-FakeRead($Acad, [string]$Method, $Params) {
  $before = Get-FakeState $Acad
  $response = Invoke-Fake $Acad $Method $Params
  Assert-Equal $before (Get-FakeState $Acad) "$Method leaves the drawing untouched"
  return $response
}

# The real name is shared by every Inertia server on this machine.
$ApplyMutexName = 'Local\InertiaCadTest-' + [guid]::NewGuid().ToString('N')

$acad = New-FakeAutoCAD
$doc = $acad.ActiveDocument
$documentId = 'acad:Plan.dwg'

$documents = (Invoke-FakeRead $acad 'documents' @{}).result.documents
Assert-Equal $documentId $documents[0].documentId 'documents carry an id built from the drawing name'
Assert-Equal 'mm' $documents[0].displayUnits 'INSUNITS 4 is millimetres'
$doc.Saved = $false; $doc.Dbmod = 24
$viewOnly = (Invoke-FakeRead $acad 'documents' @{}).result.documents[0].modified
$doc.Dbmod = 4
Assert-Equal @($false, $true) @($viewOnly, (Invoke-FakeRead $acad 'documents' @{}).result.documents[0].modified) 'zooming and panning alone are not unsaved changes'
$doc.Saved = $true; $doc.Dbmod = 0

$selection = (Invoke-FakeRead $acad 'selection' @{ documentId = $documentId }).result
Assert-Equal 3 $selection.total 'selection reads the pickfirst set'
Assert-Equal @('Model', 'Model', 'A1') @($selection.items | ForEach-Object layout) 'rows name their layout'
Assert-Equal 'A' $selection.items[2].attributes[0].value 'block attributes are listed'
Assert-Equal $null $selection.hint 'a non-empty selection carries no hint'

$query = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; types = @('line'); limit = 1 }).result
Assert-Equal 3 $query.total 'query filters by DXF type'
Assert-Equal '1' $query.nextCursor 'query pages with a cursor'
$texts = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; textContains = 'kitch' }).result
Assert-Equal @('2C') @($texts.items | ForEach-Object handle) 'query searches text'
$single = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; types = @('TEXT') }).result
Assert-Equal @('2C') @($single.items | ForEach-Object handle) 'a query matching one object returns it'
$everything = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId }).result
Assert-Equal 4 $everything.total 'an unfiltered query reads model space'
Assert-Equal @() @($doc.Registry.Values | Where-Object Deleted | ForEach-Object Handle) 'queries never erase what they match'
Assert-Equal 4 $doc.DeletedSets 'each query deletes its own selection set'
Assert-Equal $true ($doc.SetNames[0] -match '^INERTIACAD\d{10}_[0-9a-f]{6}$') 'selection set names carry their creation time'

$doc.FailSelect = $true
Assert-Equal 'HOST_ERROR' (Invoke-FakeRead $acad 'query' @{ documentId = $documentId }).error.code 'a failing Select is reported'
Assert-Equal 5 $doc.DeletedSets 'a failing Select still deletes its selection set'
$doc.FailSelect = $false

$now = Get-SetStamp
foreach ($name in 'INERTIACAD0123456789ab', "INERTIACAD$($now - 3600)_aaaaaa", "INERTIACAD$($now)_bbbbbb", 'USERSET') { [void]$doc.SelectionSets.Add($name) }
[void](Invoke-Fake $acad 'query' @{ documentId = $documentId; types = @('TEXT') })
Assert-Equal @("INERTIACAD$($now)_bbbbbb", 'USERSET') @($doc.SelectionSets.Items | ForEach-Object Name) 'queries remove selection sets left by killed runs, and only those'
$doc.SelectionSets.Items.Clear()

$slow = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; types = @('LINE'); limit = 10; deadlineMs = 0 }).result
Assert-Equal @(1, '1', $true, $true) @(@($slow.items).Count, $slow.nextCursor, $slow.partial, $slow.timeBudgetHit) 'a query out of time returns what it has and a cursor'
$slowScan = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; textContains = 'kitchen'; deadlineMs = 0 }).result
Assert-Equal @(0, '1', $true) @(@($slowScan.items).Count, $slowScan.nextCursor, $slowScan.timeBudgetHit) 'an out-of-time text scan still scans one object and resumes after it'
# Each call here has no time left, so it scans one object; following the cursor must still reach every match.
$found = New-Object System.Collections.ArrayList
$cursor = $null
for ($call = 0; $call -lt 10; $call++) {
  $page = @{ documentId = $documentId; textContains = 'kitchen'; deadlineMs = 0 }
  if ($null -ne $cursor) { $page.cursor = $cursor }
  $answer = (Invoke-FakeRead $acad 'query' $page).result
  foreach ($row in @($answer.items)) { [void]$found.Add($row.handle) }
  $cursor = $answer.nextCursor
  if ($null -eq $cursor) { break }
}
Assert-Equal @('2C') @($found) 'a filtered scan that outlasts each call still reaches every match by its cursor'
Assert-Equal $null $cursor 'the filtered scan ends without a cursor'
$paged = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; within = @{ min = @(5, 5); max = @(-1, -1) }; limit = 2 }).result
Assert-Equal @(@('1A', '1B'), '2', @(0, 1)) @(@($paged.items | ForEach-Object handle), $paged.nextCursor, @($paged.scanPositions)) 'a full filtered page resumes at the next match and reports each row''s scan position'
$rest = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; within = @{ min = @(5, 5); max = @(-1, -1) }; limit = 2; cursor = $paged.nextCursor }).result
Assert-Equal @(@('4E'), $null) @(@($rest.items | ForEach-Object handle), $rest.nextCursor) 'the next filtered page continues from the scan position'
$slowSelection = (Invoke-FakeRead $acad 'selection' @{ documentId = $documentId; deadlineAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }).result
Assert-Equal @(1, $true, $true) @(@($slowSelection.items).Count, $slowSelection.truncated, $slowSelection.timeBudgetHit) 'a selection out of time returns what it has'
$slowInfo = (Invoke-FakeRead $acad 'info' @{ documentId = $documentId; deadlineAt = [DateTime]::UtcNow.ToString('o') }).result
Assert-Equal @(0, $true) @(@($slowInfo.layers).Count, $slowInfo.timeBudgetHit) 'info out of time returns what it has'
Assert-Equal 'TIME_BUDGET' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; deadlineMs = 0; operations = @(@{ op = 'acad.set_color'; handles = @('1A'); color = 1 }) }).error.code 'a preview out of time fails clearly'
Assert-Equal 'INVALID_REQUEST' (Invoke-Fake $acad 'query' @{ documentId = $documentId; deadlineAt = 'soon' }).error.code 'an unreadable deadline is refused'
$manyOps = @(1..5 | ForEach-Object { @{ op = 'acad.set_color'; handles = @(1..500 | ForEach-Object { "F$_" }); color = 1 } })
Assert-Equal 'INVALID_REQUEST' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $manyOps }).error.code 'a change touching more than 2000 objects is refused'

$crossing = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; within = @{ min = @(5, 5); max = @(-1, -1) } }).result
Assert-Equal @('1A', '1B', '4E') @($crossing.items | ForEach-Object handle) 'a crossing region keeps what overlaps it'
$window = (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; within = @{ min = @(-1, -1); max = @(9.5, 12); mode = 'window' }; bbox = $true; fields = 'compact' }).result
Assert-Equal @('4E') @($window.items | ForEach-Object handle) 'a window region keeps only what lies inside, even when AutoCAD picks a near miss'
Assert-Equal @('handle', 'type', 'layer', 'bbox') @($window.items[0].PSObject.Properties.Name) 'compact rows carry only handle, type, layer and bbox'
Assert-Equal @(@(0, 0), @(2, 2)) $window.items[0].bbox 'bbox is the 2D bounding box'
Assert-Equal 'INVALID_REQUEST' (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; within = @{ min = @(0, 0); max = @(1, 1); mode = 'fence' } }).error.code 'unknown region modes are refused'
Assert-Equal @(@(10, 10), @(10, 10)) (Invoke-FakeRead $acad 'query' @{ documentId = $documentId; types = @('TEXT'); bbox = $true }).result.items[0].bbox 'full rows add a bbox on request'

$info = (Invoke-FakeRead $acad 'info' @{ documentId = $documentId }).result
Assert-Equal @('documentId', 'units', 'extents', 'layers', 'layersTruncated', 'blocks', 'blocksTruncated', 'layouts', 'entityCount', 'ucsIsWorld', 'viewTwistDeg') @($info.PSObject.Properties.Name) 'info returns the agreed shape'
Assert-Equal ([ordered]@{ insUnits = 'mm'; lunits = 2 }) $info.units 'info reports units'
Assert-Equal ([ordered]@{ min = @(0, 0, 0); max = @(1000, 500, 0) }) $info.extents 'info reports extents'
Assert-Equal ([ordered]@{ name = 'LOCKED'; on = $true; frozen = $false; locked = $true; color = 7; linetype = 'Continuous' }) $info.layers[3] 'info lists layer state'
Assert-Equal @('TITLE', 'DOOR') @($info.blocks) 'info skips anonymous, layout and xref blocks'
Assert-Equal @(@('Model', 'A1'), 4, $true, 0, $false) @(@($info.layouts), $info.entityCount, $info.ucsIsWorld, $info.viewTwistDeg, $info.layersTruncated) 'info reports layouts, entity count and view'
$doc.ExtMin = @(1e20, 1e20, 1e20); $doc.ExtMax = @(-1e20, -1e20, -1e20); $MaxLayers = 2
$emptyInfo = (Invoke-FakeRead $acad 'info' @{ documentId = $documentId }).result
Assert-Equal @($null, 2, $true) @($emptyInfo.extents, @($emptyInfo.layers).Count, $emptyInfo.layersTruncated) 'info drops invalid extents and caps layers'
$MaxLayers = 1000
$doc.ExtMin = @(0.0, 0.0, 0.0); $doc.ExtMax = @(1000.0, 500.0, 0.0)

$stateBefore = @($doc.Dbmod, $doc.ModelSpace.Count, $doc.Layers.Count)
$styled = (Invoke-FakeRead $acad 'info' @{ documentId = $documentId; style = $true }).result
Assert-Equal $stateBefore @($doc.Dbmod, $doc.ModelSpace.Count, $doc.Layers.Count) 'a style read leaves DBMOD and counts unchanged'
Assert-Equal @('documentId', 'units', 'extents', 'layers', 'layersTruncated', 'blocks', 'blocksTruncated', 'layouts', 'entityCount', 'ucsIsWorld', 'viewTwistDeg', 'layoutsTruncated', 'textStyles', 'textStylesTruncated', 'dimStyles', 'dimStylesTruncated', 'current') @($styled.PSObject.Properties.Name) 'info with style adds the style sections'
Assert-Equal ([ordered]@{ name = 'A-WALL'; on = $true; frozen = $false; locked = $false; color = 7; linetype = 'Continuous'; trueColor = '#804020'; lineweight = 0.5; transparency = 50 }) $styled.layers[1] 'style layers add an RGB colour, lineweight in mm and transparency'
Assert-Equal @(@($null, 'Default', 0), @($null, 0.18, $null)) @(@($styled.layers[0].trueColor, $styled.layers[0].lineweight, $styled.layers[0].transparency), @($styled.layers[2].trueColor, $styled.layers[2].lineweight, $styled.layers[2].transparency)) 'index colours have no true colour, Default stays a name, and opaque or unreadable transparency is 0 or null'
Assert-Equal @([ordered]@{ name = 'Standard'; font = 'Arial'; height = 0; widthFactor = 1 }, [ordered]@{ name = 'ROMANS'; font = 'romans.shx'; height = 2.5; widthFactor = 0.8 }) $styled.textStyles 'text styles name TrueType typefaces or SHX files and skip unnamed and xref styles'
Assert-Equal @(1, 0) @(($doc.TextStyles.Items | ForEach-Object FontCalls)[0..1]) 'only TrueType styles ask for their typeface'
Assert-Equal ([ordered]@{ names = @('Standard', 'ISO-25', 'A-1to50'); active = [ordered]@{ name = 'A-1to50'; dimtxt = 2.5; dimasz = 2; dimscale = 50; dimdec = 0 } }) $styled.dimStyles 'dim styles list names and the active style''s sizes'
Assert-Equal ([ordered]@{ layer = 'A-WALL'; textStyle = 'ROMANS'; dimStyle = 'A-1to50'; ltscale = 50 }) $styled.current 'current reports layer, styles and LTSCALE'
Assert-Equal @([ordered]@{ name = 'Model'; paper = 'Letter'; device = 'None'; plotStyleTable = $null }, [ordered]@{ name = 'A1'; paper = 'ISO_full_bleed_A1_(841.00_x_594.00_MM)'; device = 'DWG To PDF.pc3'; plotStyleTable = 'monochrome.ctb' }) $styled.layouts 'style layouts carry paper, device and plot style table'
Assert-Equal @($false, $false, $false) @($styled.layoutsTruncated, $styled.textStylesTruncated, $styled.dimStylesTruncated) 'short style lists are complete'
$MaxStyles = 1; $MaxLayouts = 1
$cappedStyle = (Invoke-FakeRead $acad 'info' @{ documentId = $documentId; style = $true }).result
Assert-Equal @(1, $true, 1, $true, 1, $true) @(@($cappedStyle.textStyles).Count, $cappedStyle.textStylesTruncated, @($cappedStyle.dimStyles.names).Count, $cappedStyle.dimStylesTruncated, @($cappedStyle.layouts).Count, $cappedStyle.layoutsTruncated) 'style lists are capped and flagged'
$MaxStyles = 100; $MaxLayouts = 100
$slowStyle = (Invoke-FakeRead $acad 'info' @{ documentId = $documentId; style = $true; deadlineMs = 0 }).result
Assert-Equal @(0, 0, $true, $true, $true) @(@($slowStyle.textStyles).Count, @($slowStyle.layouts).Count, $slowStyle.textStylesTruncated, $slowStyle.layoutsTruncated, $slowStyle.timeBudgetHit) 'a style read out of time returns what it has'
$standardText = $doc.TextStyles.Item('Standard')
$standardText.OnFont = { $doc.Dbmod = $doc.Dbmod -bor 1 }
Assert-Equal 'READ_MODIFIED_DRAWING' (Invoke-Fake $acad 'info' @{ documentId = $documentId; style = $true }).error.code 'a style read that modifies the drawing fails loudly'
$standardText.OnFont = $null; $doc.Dbmod = 0

$realRow = ${function:Get-EntityRow}
${function:Get-EntityRow} = { param($Entity, $LayoutMap, $Options = @{}, $Extent = $null) $Entity.Delete(); & $realRow $Entity $LayoutMap $Options $Extent }
Assert-Equal 'READ_MODIFIED_DRAWING' (Invoke-Fake $acad 'query' @{ documentId = $documentId; types = @('TEXT') }).error.code 'a read that modifies the drawing fails loudly'
$doc.Registry['2C'].Deleted = $false
Assert-Equal 'READ_MODIFIED_DRAWING' (Invoke-Fake $acad 'selection' @{ documentId = $documentId }).error.code 'a read that erases from an already modified drawing fails loudly'
foreach ($entity in $doc.Registry.Values) { $entity.Deleted = $false }
$doc.Dbmod = 0
$holder = Start-LockHolder
try {
  Assert-Equal $true (Invoke-Fake $acad 'query' @{ documentId = $documentId; types = @('TEXT') }).result.concurrentEdit 'a change while an edit runs is reported as concurrent, not as a read fault'
  Assert-Equal 'HOST_BUSY' (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = @(@{ op = 'acad.erase'; handles = @('1A') }) }).error.code 'a second edit waits for the first instead of running alongside it'
  Assert-Equal 0 $doc.Undo.Count 'a busy edit never reaches the drawing'
} finally {
  Stop-LockHolder $holder
}
${function:Get-EntityRow} = $realRow
foreach ($entity in $doc.Registry.Values) { $entity.Deleted = $false }
$doc.Dbmod = 0

Assert-Equal 'UNSUPPORTED_OPERATION' (Invoke-Fake $acad 'send_command' @{ command = 'ERASE ALL' }).error.code 'arbitrary commands are refused'
Assert-Equal 'NESTED_TARGET' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_layer'; handles = @('3D'); layer = 'A-ANNO' }) }).error.code 'block-definition contents are refused'
Assert-Equal 'NOT_DRAWING_OBJECT' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_color'; handles = @('L1'); color = 1 }) }).error.code 'a layer handle is not a drawing object'
Assert-Equal 'LOCKED' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_color'; handles = @('4E'); color = 1 }) }).error.code 'locked layers are refused'
Assert-Equal 'LAYER_NOT_FOUND' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_layer'; handles = @('1A'); layer = 'NEW' }) }).error.code 'unknown layers are refused'
Assert-Equal $null (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.add_line'; start = @(500000, 4600000000); end = @(500100, 4600000000) }) }).error 'georeferenced coordinates are accepted'
$farAway = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.add_line'; start = @(0, 0); end = @(1e13, 0) }) }).error
Assert-Equal @('INVALID_REQUEST', $true) @($farAway.code, ($farAway.message -like 'end is out of range*')) 'absurd coordinates are out of range'

$operations = @(@{ op = 'acad.create_layer'; name = 'A-DEMO'; color = 1 }, @{ op = 'acad.set_layer'; handles = @('1A', '1B'); layer = 'A-DEMO' })
$doc.Layers.Enumerations = 0
$preview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $operations }).result
Assert-Equal 3 @($preview.changes).Count 'preview lists every change'
Assert-Equal 'A-WALL' $doc.Registry['1A'].Layer 'preview does not change the drawing'
Assert-Equal 0 $doc.Layers.Enumerations 'layers are looked up by name, not by walking the table'

$applied = (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $operations; expectedFingerprints = $preview.fingerprints }).result
Assert-Equal 'applied' $applied.status 'a previewed change applies'
Assert-Equal @('A-DEMO', 'A-DEMO') @($doc.Registry['1A'].Layer, $doc.Registry['1B'].Layer) 'both lines moved to the new layer'
Assert-Equal @('start', 'end') @($doc.Undo) 'the change is one undo group'
Assert-Equal 1 $doc.Regens 'a finished edit regenerates the view'

$moveOps = @(@{ op = 'acad.move'; handles = @('2C'); vector = @(5, 0) })
$movePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $moveOps }).result
Assert-Equal ([ordered]@{ op = 'acad.move'; target = 'TEXT 2C'; field = 'position'; before = [ordered]@{ position = @(10, 10, 0) }; after = [ordered]@{ position = @(15, 10, 0) } }) $movePreview.changes[0] 'a move previews the position before and after'
$doc.Registry['2C'].TextString = 'PANTRY'
Assert-Equal 'TARGET_CHANGED' (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $moveOps; expectedFingerprints = $movePreview.fingerprints }).error.code 'a target edited after preview is refused'
Assert-Equal @(2, 1, @(10, 10, 0)) @($doc.Undo.Count, $doc.Regens, @($doc.Registry['2C'].InsertionPoint)) 'a stale change is refused before any step'

$attributeOps = @(@{ op = 'acad.set_attribute'; handles = @('5F'); tag = 'rev'; value = 'B' })
$attributePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $attributeOps }).result
[void](Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $attributeOps; expectedFingerprints = $attributePreview.fingerprints })
Assert-Equal 'B' $doc.Registry['5F'].Attribute.TextString 'attribute values update by tag'

$blockEraseOps = @(@{ op = 'acad.erase'; handles = @('5F') })
$blockErase = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $blockEraseOps }).result
Assert-Equal $true ($null -ne $blockErase.fingerprints.'block:5F') 'erasing a block insert fingerprints its definition'
$doc.Registry['5F'].XScaleFactor = 2.0
$undoBefore = $doc.Undo.Count
Assert-Equal 'TARGET_CHANGED' (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $blockEraseOps; expectedFingerprints = $blockErase.fingerprints }).error.code 'a block insert rescaled after the preview is not erased'
$blockErase = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $blockEraseOps }).result
$doc.Blocks.Item('TITLE').Items[0].EndPoint = @(594.0, 0.0, 0.0)
Assert-Equal 'TARGET_CHANGED' (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $blockEraseOps; expectedFingerprints = $blockErase.fingerprints }).error.code 'a block whose definition changed after the preview is not erased'
Assert-Equal $undoBefore $doc.Undo.Count 'a stale erase never reaches the drawing'
Assert-Equal $false $doc.Registry['5F'].Deleted 'the changed insert is still there'
$doc.Registry['5F'].XScaleFactor = 1.0

$lineOps = @(@{ op = 'acad.add_line'; start = @(0, 0); end = @(100, 0, 0); layer = 'A-DEMO' })
$linePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $lineOps }).result
$created = (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $lineOps; expectedFingerprints = $linePreview.fingerprints }).result.created
Assert-Equal 'LINE' $created[0].type 'new lines report their handle and type'
Assert-Equal 'A-DEMO' $doc.Registry[$created[0].handle].Layer 'new lines land on the requested layer'

$eraseOps = @(@{ op = 'acad.erase'; handles = @('1B') }, @{ op = 'acad.set_color'; handles = @('1A'); color = 3 })
$erasePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $eraseOps }).result
Add-Member -InputObject $doc.Registry['1A'] -MemberType ScriptProperty -Name Color -Value { 256 } -SecondValue { throw 'eDuplicateRecordName' } -Force
$doc.Undo.Clear()
$partial = Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $eraseOps; expectedFingerprints = $erasePreview.fingerprints }
Assert-Equal 'PARTIALLY_APPLIED' $partial.error.code 'a failure after the first step is reported honestly'
Assert-Equal @('start', 'end') @($doc.Undo) 'a failed apply still closes its undo group'

$doc.Registry['1A'] = Add-FakeEntity $doc (New-FakeEntity '1A' 'AcDbLine' 'A-WALL' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(1000.0, 0.0, 0.0) })
$roundTrip = @(@{ op = 'acad.set_layer'; handles = @('1A'); layer = 'A-ANNO' }, @{ op = 'acad.set_layer'; handles = @('1A'); layer = 'A-WALL' })
$roundTripPreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $roundTrip }).result
Assert-Equal @('A-WALL', 'A-ANNO') @($roundTripPreview.changes | ForEach-Object before) 'a later layer change sees the earlier one'
[void](Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $roundTrip; expectedFingerprints = $roundTripPreview.fingerprints })
Assert-Equal 'A-WALL' $doc.Registry['1A'].Layer 'the last layer change in a batch wins'

$doc.Layers.Factory = {
  param($Name)
  $layer = [pscustomobject]@{ Name = $Name; Lock = $false; Collection = $doc.Layers }
  Add-Member -InputObject $layer -MemberType ScriptProperty -Name Color -Value { 7 } -SecondValue { throw 'eInvalidColor' }
  Add-Member -InputObject $layer -MemberType ScriptMethod -Name Delete -Value { $this.Collection.Items.Remove($this) }
  return $layer
}
$colorOps = @(@{ op = 'acad.create_layer'; name = 'A-BROKEN'; color = 3 })
$colorPreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $colorOps }).result
$failed = Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $colorOps; expectedFingerprints = $colorPreview.fingerprints }
Assert-Equal 'APPLY_FAILED' $failed.error.code 'a step that fails after creating something removes it and reports nothing changed'
Assert-Equal $null (Get-Layer $doc 'A-BROKEN') 'the half-made layer is gone'

# Rotations.
$rot = New-FakeAutoCAD
$rotDoc = $rot.ActiveDocument
$chair = Add-FakeEntity $rotDoc (New-FakeEntity '60' 'AcDbBlockReference' '0' 1 @{ Name = 'CHAIR'; EffectiveName = 'CHAIR'; HasAttributes = $false; InsertionPoint = @(10.0, 0.0, 0.0); Rotation = [Math]::PI / 12; XScaleFactor = 1.0; YScaleFactor = 1.0; ZScaleFactor = 1.0 })
$label = Add-FakeEntity $rotDoc (New-FakeEntity '61' 'AcDbMText' 'A-ANNO' 1 @{ TextString = 'ROOM'; InsertionPoint = @(0.0, 10.0, 0.0); Height = 2.5; Rotation = 0.0 })
[void](Add-FakeEntity $rotDoc (New-FakeEntity '62' 'AcDbBlockReference' '0' 99 @{ Name = 'CHAIR'; InsertionPoint = @(0.0, 0.0, 0.0); Rotation = 0.0 }))
[void](Add-FakeEntity $rotDoc (New-FakeEntity '63' 'AcDbPolyline' '0' 1 @{ Coordinates = [double[]]@(0, 0, 5, 0); Closed = $false; Length = 5.0 }))
function Get-Near($Point) { return , @($Point | ForEach-Object { [Math]::Round($_, 6) + 0.0 }) }
function Invoke-RotApply($Ops) {
  $preview = (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = $Ops }).result
  $rotDoc.Undo.Clear()
  return Invoke-Fake $rot 'apply' @{ documentId = $documentId; operations = $Ops; expectedFingerprints = $preview.fingerprints }
}
$straighten = @(@{ op = 'acad.set_rotation'; handles = @('60'); rotationDeg = 0 })
$straightenPreview = (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = $straighten }).result
Assert-Equal @([ordered]@{ op = 'acad.set_rotation'; target = 'INSERT 60'; field = 'rotationDeg'; before = 15; after = 0 }) @($straightenPreview.changes) 'a set_rotation preview lists the rotation before and after without changing the drawing'
Assert-Equal 270 (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_rotation'; handles = @('61'); rotationDeg = -90 }) }).result.changes[0].after 'rotations preview as AutoCAD reads them back, in [0, 360)'
Assert-Equal 'applied' (Invoke-RotApply $straighten).result.status 'set_rotation applies'
Assert-Equal @(0, @('start', 'end')) @($chair.Rotation, @($rotDoc.Undo)) 'set_rotation sets the absolute rotation in one undo group'
Assert-Equal 'NESTED_TARGET' (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_rotation'; handles = @('62'); rotationDeg = 0 }) }).error.code 'set_rotation refuses an insert inside a block definition'
Assert-Equal 'UNSUPPORTED_TARGET' (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_rotation'; handles = @('1A'); rotationDeg = 0 }) }).error.code 'set_rotation refuses objects without a rotation'
Assert-Equal 'INVALID_REQUEST' (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.rotate'; handles = @('60'); basePoint = @(0, 0); angleDeg = 'Infinity' }) }).error.code 'rotate refuses an infinite angle'
Assert-Equal 'INVALID_REQUEST' (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.rotate'; handles = @('60'); angleDeg = 90 }) }).error.code 'rotate needs a basePoint'
$chained = (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_rotation'; handles = @('60'); rotationDeg = 30 }, @{ op = 'acad.rotate'; handles = @('60'); basePoint = @(10, 0); angleDeg = 90 }) }).result
Assert-Equal @(30, 120) @($chained.changes[1].before.rotationDeg, $chained.changes[1].after.rotationDeg) 'a rotate sees a set_rotation earlier in the batch'
$shift = (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.move'; handles = @('1A', '63'); vector = @(5, 0) }) }).result
Assert-Equal @([ordered]@{ start = @(0, 0, 0); end = @(1000, 0, 0) }, [ordered]@{ start = @(5, 0, 0); end = @(1005, 0, 0) }, $null, 'moved by [5, 0]') @($shift.changes[0].before, $shift.changes[0].after, $shift.changes[1].before, $shift.changes[1].after) 'a move shows line ends before and after, and describes other objects'
$turn = @(@{ op = 'acad.rotate'; handles = @('60', '61', '1A', '63'); basePoint = @(0, 0); angleDeg = 90 }, @{ op = 'acad.rotate'; handles = @('60', '61', '1A', '63'); basePoint = @(0, 0); angleDeg = -90 })
$turnPreview = (Invoke-FakeRead $rot 'preview' @{ documentId = $documentId; operations = $turn }).result
Assert-Equal ([ordered]@{ op = 'acad.rotate'; target = 'INSERT 60'; field = 'placement'; before = [ordered]@{ position = @(10, 0, 0); rotationDeg = 0 }; after = [ordered]@{ position = @(0, 10, 0); rotationDeg = 90 } }) $turnPreview.changes[0] 'rotate previews an insert''s position and rotation'
Assert-Equal @([ordered]@{ start = @(0, 0, 0); end = @(0, 1000, 0) }, $null, "rotated 90$([char]0xB0) about [0, 0]") @($turnPreview.changes[2].after, $turnPreview.changes[3].before, $turnPreview.changes[3].after) 'rotate shows line ends and describes other objects'
Assert-Equal @([ordered]@{ position = @(0, 10, 0); rotationDeg = 90 }, [ordered]@{ position = @(-10, 0, 0); rotationDeg = 90 }) @($turnPreview.changes[4].before, $turnPreview.changes[5].before) 'the second rotate sees the first'
Assert-Equal 'applied' (Invoke-RotApply $turn).result.status 'rotate applies'
Assert-Equal @(@(10, 0, 0), 0, @(0, 10, 0), 0, @(1000, 0, 0), @('start', 'end')) @((Get-Near $chair.InsertionPoint), [Math]::Round($chair.Rotation, 9), (Get-Near $label.InsertionPoint), [Math]::Round($label.Rotation, 9), (Get-Near $rotDoc.Registry['1A'].EndPoint), @($rotDoc.Undo)) 'rotating there and back in one batch round-trips in one undo group'
[void](Invoke-RotApply @(@{ op = 'acad.rotate'; handles = @('60'); basePoint = @(0, 0); angleDeg = 90 }))
Assert-Equal @(@(0, 10, 0), 90) @((Get-Near $chair.InsertionPoint), (Get-RotationDeg $chair.Rotation)) 'rotate turns an insert about the base point'

# Copy, mirror, scale, offset, blocks, arcs, hatches and dimensions.
$edit = New-FakeAutoCAD
$editDoc = $edit.ActiveDocument
$ring = Add-FakeEntity $editDoc (New-FakeEntity '70' 'AcDbCircle' 'A-WALL' 1 @{ Center = @(100.0, 100.0, 0.0); Radius = 10.0 })
$ring.Color = 3
[void](Add-FakeEntity $editDoc (New-FakeEntity '71' 'AcDbRotatedDimension' 'A-ANNO' 1 @{ Measurement = 5.0; TextOverride = ''; TextPosition = @(2.0, 1.0, 0.0); Rotation = 0.0 }))
[void](Add-FakeEntity $editDoc (New-FakeEntity '73' 'AcDbPolyline' 'A-WALL' 1 @{ Coordinates = [double[]]@(0, 0, 20, 0, 20, 10, 0, 10); Closed = $true; Length = 60.0 }))
function Invoke-EditPreview($Ops) { return Invoke-FakeRead $edit 'preview' @{ documentId = $documentId; operations = $Ops } }
function Invoke-EditApply($Ops, [string]$Name, [switch]$Fails) {
  $preview = (Invoke-EditPreview $Ops).result
  $editDoc.Undo.Clear()
  $response = Invoke-Fake $edit 'apply' @{ documentId = $documentId; operations = $Ops; expectedFingerprints = $preview.fingerprints }
  Assert-Equal @('start', 'end') @($editDoc.Undo) "$Name applies as one undo group"
  if (-not $Fails) { Assert-Equal $null $response.error "$Name applies" }
  return @{ preview = $preview; result = $response.result; error = $response.error }
}
function Get-EditError($Ops) { return (Invoke-EditPreview $Ops).error.code }
function Get-Style($Entity) { return @($Entity.Color, $Entity.Linetype, $Entity.Lineweight) }
$liveCount = { @($editDoc.Registry.Values | Where-Object { -not $_.Deleted }).Count }

$copy = Invoke-EditApply @(@{ op = 'acad.copy'; handles = @('70'); vector = @(50, 0); count = 2 }) 'copy'
Assert-Equal @('2 copies, offset by [50, 0] each', [ordered]@{ min = @(90, 90); max = @(210, 110) }) @($copy.preview.changes[0].after, $copy.preview.bbox) 'a copy previews its count and the box it will cover'
Assert-Equal @('CIRCLE', 'CIRCLE') @($copy.result.created | ForEach-Object type) 'copies report their handles'
Assert-Equal @(@(150, 100, 0), @(200, 100, 0), @(100, 100, 0)) @(@($copy.result.created | ForEach-Object { , @($editDoc.Registry[$_.handle].Center) }) + , @($ring.Center)) 'copies step by the vector and leave the source'
Assert-Equal @(3, 'ByLayer', -1, 'A-WALL') @((Get-Style $editDoc.Registry[$copy.result.created[0].handle]) + $editDoc.Registry[$copy.result.created[0].handle].Layer) 'copies keep the source''s properties'
foreach ($count in 0, 51, 2.5) { Assert-Equal 'INVALID_REQUEST' (Get-EditError @(@{ op = 'acad.copy'; handles = @('70'); vector = @(1, 0); count = $count })) "copy refuses count $count" }
Assert-Equal @('NESTED_TARGET', 'LOCKED') @((Get-EditError @(@{ op = 'acad.copy'; handles = @('3D'); vector = @(1, 0) })), (Get-EditError @(@{ op = 'acad.copy'; handles = @('4E'); vector = @(1, 0) }))) 'copy refuses nested and locked objects'

$mirrorOps = @(@{ op = 'acad.mirror'; handles = @('1B'); p1 = @(10, 0); p2 = @(10, 1); keepSource = $false })
Assert-Equal 'TARGET_NOT_FOUND' (Get-EditError ($mirrorOps + @{ op = 'acad.set_color'; handles = @('1B'); color = 1 })) 'a later op sees that a mirror erased its source'
$mirror = Invoke-EditApply $mirrorOps 'mirror'
Assert-Equal @('mirrored copy about [10, 0] to [10, 1], original erased', [ordered]@{ min = @(0, 0); max = @(20, 500) }) @($mirror.preview.changes[0].after, $mirror.preview.bbox) 'a mirror previews the copy and the box'
$mirrored = $editDoc.Registry[$mirror.result.created[0].handle]
Assert-Equal @('LINE', @(20, 0, 0), @(20, 500, 0), $true) @($mirror.result.created[0].type, @($mirrored.StartPoint), @($mirrored.EndPoint), $editDoc.Registry['1B'].Deleted) 'mirror reflects a copy and erases the source when asked'
Assert-Equal @('UNSUPPORTED_TARGET', 'INVALID_REQUEST', 'LOCKED') @((Get-EditError @(@{ op = 'acad.mirror'; handles = @('71'); p1 = @(0, 0); p2 = @(0, 1) })), (Get-EditError @(@{ op = 'acad.mirror'; handles = @('70'); p1 = @(1, 1); p2 = @(1, 1) })), (Get-EditError @(@{ op = 'acad.mirror'; handles = @('4E'); p1 = @(0, 0); p2 = @(0, 1) }))) 'mirror refuses dimensions, a zero-length axis and locked objects'
$kept = Invoke-EditApply @(@{ op = 'acad.mirror'; handles = @('70'); p1 = @(0, 0); p2 = @(1, 0) }) 'mirror keeping the source'
Assert-Equal @(@(100, -100, 0), $false) @(@($editDoc.Registry[$kept.result.created[0].handle].Center), $ring.Deleted) 'mirror keeps the source by default'

$scaleOps = @(@{ op = 'acad.scale'; handles = @('70'); basePoint = @(0, 0); factor = 2 }, @{ op = 'acad.move'; handles = @('70'); vector = @(1, 0) })
$scale = Invoke-EditApply $scaleOps 'scale'
Assert-Equal @([ordered]@{ center = @(100, 100, 0) }, [ordered]@{ center = @(200, 200, 0) }, [ordered]@{ center = @(200, 200, 0) }) @($scale.preview.changes[0].before, $scale.preview.changes[0].after, $scale.preview.changes[1].before) 'scale previews points before and after, and a later move sees it'
Assert-Equal ([ordered]@{ min = @(90, 90); max = @(221, 220) }) $scale.preview.bbox 'the preview box follows scale then move'
Assert-Equal @(@(201, 200, 0), 20) @(@($ring.Center), $ring.Radius) 'scale applies about the base point'
foreach ($factor in 0, -1, 'Infinity') { Assert-Equal 'INVALID_REQUEST' (Get-EditError @(@{ op = 'acad.scale'; handles = @('70'); basePoint = @(0, 0); factor = $factor })) "scale refuses factor $factor" }
Assert-Equal @('UNSUPPORTED_TARGET', 'NESTED_TARGET') @((Get-EditError @(@{ op = 'acad.scale'; handles = @('71'); basePoint = @(0, 0); factor = 2 })), (Get-EditError @(@{ op = 'acad.scale'; handles = @('3D'); basePoint = @(0, 0); factor = 2 }))) 'scale refuses dimensions and nested objects'

$offset = Invoke-EditApply @(@{ op = 'acad.offset'; handle = '1A'; distance = 10 }) 'offset'
$offsetLine = $editDoc.Registry[$offset.result.created[0].handle]
Assert-Equal @('LINE', @(0, 10, 0), @(1000, 10, 0), [ordered]@{ min = @(-10, -10); max = @(1010, 10) }) @($offset.result.created[0].type, @($offsetLine.StartPoint), @($offsetLine.EndPoint), $offset.preview.bbox) 'offset reports the new curve and previews a box around both sides'
Assert-Equal @('UNSUPPORTED_TARGET', 'INVALID_REQUEST', 'INVALID_REQUEST', 'LOCKED') @((Get-EditError @(@{ op = 'acad.offset'; handle = '2C'; distance = 1 })), (Get-EditError @(@{ op = 'acad.offset'; handles = @('1A', '70'); distance = 1 })), (Get-EditError @(@{ op = 'acad.offset'; handle = '1A'; distance = 0 })), (Get-EditError @(@{ op = 'acad.offset'; handle = '4E'; distance = 1 }))) 'offset refuses text, several handles, a zero distance and locked curves'

$insert = Invoke-EditApply @(@{ op = 'acad.insert_block'; name = 'door'; position = @(5, 5); rotationDeg = 90; scale = 2; layer = 'A-ANNO' }) 'insert_block'
$door = $editDoc.Registry[$insert.result.created[0].handle]
Assert-Equal @('new block', 'DOOR at [5, 5], rotated 90 degrees, scale 2, model space on layer A-ANNO', [ordered]@{ min = @(5, 5); max = @(5, 5) }) @($insert.preview.changes[0].target, $insert.preview.changes[0].after, $insert.preview.bbox) 'insert_block previews the block, placement and layer'
Assert-Equal @('INSERT', 'DOOR', @(5, 5, 0), 90, 2, 'A-ANNO', 256, 'ByLayer', -1) (@($insert.result.created[0].type, $door.Name, @($door.InsertionPoint), (Get-RotationDeg $door.Rotation), $door.XScaleFactor, $door.Layer) + (Get-Style $door)) 'insert_block places an existing block ByLayer'
Assert-Equal @('BLOCK_NOT_FOUND', 'BLOCK_NOT_FOUND', 'UNSUPPORTED_TARGET', 'UNSUPPORTED_TARGET', 'UNSUPPORTED_TARGET', 'UNSUPPORTED_TARGET') @('WINDOW', 'C:\blocks\door.dwg', '*U12', 'SITE', 'SITE|TREE', 'A1-LAYOUT' | ForEach-Object { Get-EditError @(@{ op = 'acad.insert_block'; name = $_; position = @(0, 0) }) }) 'insert_block refuses unknown names, files, and anonymous, xref and layout blocks'
Assert-Equal 'INVALID_REQUEST' (Get-EditError @(@{ op = 'acad.insert_block'; name = 'DOOR'; position = @(0, 0); scale = 0 })) 'insert_block refuses a zero scale'

$arc = Invoke-EditApply @(@{ op = 'acad.add_arc'; center = @(0, 0); radius = 5; startDeg = 0; endDeg = 90 }) 'add_arc'
$arcEntity = $editDoc.Registry[$arc.result.created[0].handle]
Assert-Equal @('ARC', 0, 90, 5, '0', [ordered]@{ min = @(-5, -5); max = @(5, 5) }) @($arc.result.created[0].type, (Get-Degrees $arcEntity.StartAngle), (Get-Degrees $arcEntity.EndAngle), $arcEntity.Radius, $arcEntity.Layer, $arc.preview.bbox) 'add_arc draws on the current layer from degrees'
Assert-Equal @(256, 'ByLayer', -1) (Get-Style $arcEntity) 'new objects are ByLayer even when the current color, linetype and lineweight are not'

$before = & $liveCount
$solid = Invoke-EditApply @(@{ op = 'acad.add_hatch'; boundary = @(@(0, 0), @(10, 0), @(10, 10), @(0, 10)); layer = 'A-ANNO' }) 'add_hatch'
$hatch = $editDoc.Registry[$solid.result.created[0].handle]
$temporary = $editDoc.Registry[$hatch.Loop[0]]
Assert-Equal @(1, 'HATCH', 'SOLID', 100, $false, 'A-ANNO') @(@($solid.result.created).Count, $solid.result.created[0].type, $hatch.PatternName, $hatch.Area, $hatch.AssociativeHatch, $hatch.Layer) 'a point-bounded hatch reports only the hatch'
Assert-Equal @('AcDbPolyline', $true, $true, ($before + 1)) @($temporary.ObjectName, $temporary.Closed, $temporary.Deleted, (& $liveCount)) 'the temporary boundary is closed, then erased'
Assert-Equal @('SOLID hatch inside a 4-point boundary, model space on layer A-ANNO', [ordered]@{ min = @(0, 0); max = @(10, 10) }) @($solid.preview.changes[0].after, $solid.preview.bbox) 'a hatch previews its boundary box'
$pattern = Invoke-EditApply @(@{ op = 'acad.add_hatch'; boundary = @('73'); pattern = 'ansi31'; scale = 2; angleDeg = 45 }) 'patterned add_hatch'
$patterned = $editDoc.Registry[$pattern.result.created[0].handle]
Assert-Equal @('ANSI31', 2, 45, @('73'), 200, $false, [ordered]@{ min = @(0, 0); max = @(20, 10) }) @($patterned.PatternName, $patterned.PatternScale, (Get-Degrees $patterned.PatternAngle), @($patterned.Loop), $patterned.Area, $editDoc.Registry['73'].Deleted, $pattern.preview.bbox) 'a handle-bounded hatch keeps its boundary'
Assert-Equal @('INVALID_REQUEST', 'INVALID_REQUEST', 'LOCKED', 'UNSUPPORTED_TARGET', 'INVALID_REQUEST') @((Get-EditError @(@{ op = 'acad.add_hatch'; boundary = @('73'); pattern = 'ANSI31;(command)' })), (Get-EditError @(@{ op = 'acad.add_hatch'; boundary = @('73'); scale = 0 })), (Get-EditError @(@{ op = 'acad.add_hatch'; boundary = @('4E') })), (Get-EditError @(@{ op = 'acad.add_hatch'; boundary = @('2C') })), (Get-EditError @(@{ op = 'acad.add_hatch'; boundary = @(@(0, 0), @(1, 1)) }))) 'add_hatch refuses unsafe patterns, bad scales, locked or unsuitable boundaries and too few points'
$before = & $liveCount
Assert-Equal 'APPLY_FAILED' (Invoke-EditApply @(@{ op = 'acad.add_hatch'; boundary = @(@(0, 0), @(10, 0), @(10, 10)); pattern = 'NOPE' }) 'unknown pattern' -Fails).error.code 'AutoCAD refusing a pattern changes nothing'
Assert-Equal 'APPLY_FAILED' (Invoke-EditApply @(@{ op = 'acad.add_hatch'; boundary = @('1A') }) 'open boundary' -Fails).error.code 'a hatch that cannot evaluate is removed and reported as nothing changed'
Assert-Equal $before (& $liveCount) 'failed hatches leave nothing behind'

$aligned = Invoke-EditApply @(@{ op = 'acad.add_dimension'; kind = 'aligned'; p1 = @(0, 0); p2 = @(30, 40); textPosition = @(0, 10) }) 'aligned add_dimension'
$linear = Invoke-EditApply @(@{ op = 'acad.add_dimension'; kind = 'linear'; p1 = @(0, 0); p2 = @(30, 40); textPosition = @(15, -5); rotationDeg = 0 }) 'linear add_dimension'
Assert-Equal @('DIMENSION', 50, 'AcDbAlignedDimension', 'DIMENSION', 30, 'AcDbRotatedDimension') @($aligned.result.created[0].type, $editDoc.Registry[$aligned.result.created[0].handle].Measurement, $editDoc.Registry[$aligned.result.created[0].handle].ObjectName, $linear.result.created[0].type, $editDoc.Registry[$linear.result.created[0].handle].Measurement, $editDoc.Registry[$linear.result.created[0].handle].ObjectName) 'add_dimension draws aligned and linear dimensions'
Assert-Equal ([ordered]@{ min = @(0, 0); max = @(30, 40) }) $aligned.preview.bbox 'a dimension previews its points box'
Assert-Equal @('INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST') @((Get-EditError @(@{ op = 'acad.add_dimension'; kind = 'aligned'; p1 = @(0, 0); p2 = @(1, 0); textPosition = @(0, 1); rotationDeg = 10 })), (Get-EditError @(@{ op = 'acad.add_dimension'; kind = 'radial'; p1 = @(0, 0); p2 = @(1, 0); textPosition = @(0, 1) })), (Get-EditError @(@{ op = 'acad.add_dimension'; kind = 'linear'; p1 = @(1, 1); p2 = @(1, 1); textPosition = @(0, 1) }))) 'add_dimension refuses a rotated aligned dimension, unknown kinds and zero length'
Assert-Equal ([ordered]@{ min = @(0, 0); max = @(1000, 0) }) (Invoke-EditPreview @(@{ op = 'acad.set_color'; handles = @('1A'); color = 1 })).result.bbox 'property edits preview the box of what they touch'

# Guards around the apply.
$guard = New-FakeAutoCAD
$guardDoc = $guard.ActiveDocument
$guardOps = @(@{ op = 'acad.set_color'; handles = @('1A'); color = 1 })
$guardPreview = (Invoke-Fake $guard 'preview' @{ documentId = $documentId; operations = $guardOps }).result
function Invoke-GuardApply([hashtable]$Extra = @{}) {
  $params = @{ documentId = $documentId; operations = $guardOps; expectedFingerprints = $guardPreview.fingerprints }
  foreach ($key in $Extra.Keys) { $params[$key] = $Extra[$key] }
  return Invoke-Fake $guard 'apply' $params
}
$guardDoc.CmdActive = 1
Assert-Equal 'HOST_BUSY' (Invoke-GuardApply).error.code 'an edit waits while AutoCAD runs a command'
$guardDoc.CmdActive = 0; $guardDoc.UndoCtl = 0
Assert-Equal 'UNDO_DISABLED' (Invoke-GuardApply).error.code 'an edit is refused when one Undo could not revert it'
$guardDoc.UndoCtl = 5
Assert-Equal @(256, 0, 0) @($guardDoc.Registry['1A'].Color, $guardDoc.Undo.Count, $guardDoc.Regens) 'refused edits never reach the drawing'
Add-Member -InputObject $guardDoc.Registry['1A'] -MemberType ScriptProperty -Name Color -Value { 256 } -SecondValue { throw (New-Object System.Runtime.InteropServices.COMException 'Call was rejected by callee.', -2147418111) } -Force
Assert-Equal 'APPLY_UNCONFIRMED' (Invoke-GuardApply).error.code 'AutoCAD going silent mid-edit is unconfirmed, never busy'
Assert-Equal @('start', 'end') @($guardDoc.Undo) 'the undo group still closes'
Add-Member -InputObject $guardDoc.Registry['1A'] -MemberType ScriptProperty -Name Color -Value { 256 } -SecondValue { throw (New-Object System.Runtime.InteropServices.COMException 'The object invoked has disconnected from its clients.', -2147417848) } -Force
Assert-Equal 'APPLY_UNCONFIRMED' (Invoke-GuardApply).error.code 'AutoCAD dropping the connection mid-edit is unconfirmed'
Add-Member -InputObject $guardDoc.Registry['1A'] -MemberType ScriptProperty -Name Color -Value { 256 } -SecondValue { throw (New-Object System.Runtime.InteropServices.COMException 'eLockViolation', -2145386390) } -Force
Assert-Equal 'APPLY_FAILED' (Invoke-GuardApply).error.code 'an edit AutoCAD itself refuses is reported as nothing changed'
Assert-Equal 0 $guardDoc.Regens 'an edit that changed nothing does not regenerate the view'
[void](Add-FakeEntity $guardDoc (New-FakeEntity '1A' 'AcDbLine' 'A-WALL' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(1000.0, 0.0, 0.0); Length = 1000.0 }))
$guardDoc.FailEndUndo = $true
Assert-Equal 'applied' (Invoke-GuardApply).result.status 'a failing EndUndoMark does not turn a finished edit into an error'
Assert-Equal 1 $guardDoc.Registry['1A'].Color 'the guarded edit ran'

# Two drawings with the same file name from different folders.
$twin = New-FakeAutoCAD
$twinA = $twin.ActiveDocument
$twinB = (New-FakeAutoCAD).ActiveDocument
$twinA.FullName = 'C:\Jobs\A\Planta.dwg'; $twinA.Name = 'Planta.dwg'
$twinB.FullName = 'C:\Jobs\B\Planta.dwg'; $twinB.Name = 'Planta.dwg'
$twin.Documents = @($twinA, $twinB); $twin.ActiveDocument = $twinB
Assert-Equal @($false, $true) @((Invoke-FakeRead $twin 'documents' @{}).result.documents | ForEach-Object active) 'only the active drawing is active, not its namesake'
$twinOps = @(@{ op = 'acad.set_color'; handles = @('1A'); color = 1 })
$twinPreview = (Invoke-Fake $twin 'preview' @{ documentId = 'acad:C:\Jobs\A\Planta.dwg'; operations = $twinOps }).result
Assert-Equal 'INACTIVE_DOCUMENT' (Invoke-Fake $twin 'apply' @{ documentId = 'acad:C:\Jobs\A\Planta.dwg'; operations = $twinOps; expectedFingerprints = $twinPreview.fingerprints }).error.code 'edits refuse an inactive namesake drawing'
$twinA.Pickfirst = @()
Assert-Equal $true ((Invoke-FakeRead $twin 'selection' @{ documentId = 'acad:C:\Jobs\A\Planta.dwg' }).result.hint -like '*not the active tab*') 'an empty selection in an inactive drawing explains why'
$twinB.Pickfirst = @(); $twinB.PickfirstVar = 0
Assert-Equal $true ((Invoke-FakeRead $twin 'selection' @{ documentId = 'acad:C:\Jobs\B\Planta.dwg' }).result.hint -like 'PICKFIRST is 0*') 'an empty selection with PICKFIRST off explains why'

# Geometry rows.
$geo = New-FakeAutoCAD -Empty
$geoDoc = $geo.ActiveDocument
$arc = Add-FakeEntity $geoDoc (New-FakeEntity '10' 'AcDbPolyline' '0' 1 @{ Coordinates = [double[]]@(0, 0, 10, 0, 10, 10); Closed = $false; Length = 10 + 5 * [Math]::PI; Elevation = 5.0; Normal = [double[]]@(0, 0, -1); Bulges = @(0.0, 1.0, 0.0); BulgeCalls = 0 })
$straight = New-Object 'double[]' 500
for ($i = 0; $i -lt 250; $i++) { $straight[2 * $i] = $i }
$long = Add-FakeEntity $geoDoc (New-FakeEntity '11' 'AcDbPolyline' '0' 1 @{ Coordinates = $straight; Closed = $false; Length = 249.0; Elevation = 0.0; Normal = [double[]]@(0, 0, 1); Bulges = @(); BulgeCalls = 0 })
foreach ($polyline in $arc, $long) { Add-Member -InputObject $polyline -MemberType ScriptMethod -Name GetBulge -Value { param($Index) $this.BulgeCalls++; [double]$this.Bulges[$Index] } }
[void](Add-FakeEntity $geoDoc (New-FakeEntity '12' 'AcDbSpline' '0' 1 @{ NumberOfFitPoints = 3; NumberOfControlPoints = 2; ControlPoints = [double[]]@(0, 0, 0, 5, 5, 1) }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '13' 'AcDbEllipse' '0' 1 @{ Center = [double[]]@(1, 2, 0); MajorAxis = [double[]]@(4, 0, 0); RadiusRatio = 0.5; StartParameter = 0.0; EndParameter = 2 * [Math]::PI }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '14' 'AcDb2dPolyline' '0' 1 @{ Coordinates = [double[]]@(0, 0, 7, 3, 4, 7); Closed = $true; Length = 10.0; Elevation = 7.0; Normal = [double[]]@(0, 0, 1) }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '15' 'AcDb3dPolyline' '0' 1 @{ Coordinates = [double[]]@(0, 0, 1, 3, 4, 2); Closed = $false; Length = 5.1 }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '16' 'AcDbMText' '0' 1 @{ TextString = '{\fArial|b1;\C1;LIVING}\PROOM \U+00B2'; InsertionPoint = @(0.0, 0.0, 0.0); Height = 2.5; StyleName = 'Standard'; Width = 12.5; AttachmentPoint = 5 }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '17' 'AcDbText' '0' 1 @{ TextString = 'SIGN'; InsertionPoint = @(4.0, 4.5, 0.0); Height = 0.25; StyleName = 'ROMANS'; ScaleFactor = 0.8; Rotation = [Math]::PI / 2; Alignment = 10; TextAlignmentPoint = @(5.0, 5.0, 0.0) }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '18' 'AcDbRotatedDimension' '0' 1 @{ Measurement = 5.9; TextOverride = ''; TextPosition = @(2.95, 1.0, 0.0); Rotation = 0.0 }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '19' 'AcDbAlignedDimension' '0' 1 @{ Measurement = 5.0; TextOverride = '<> m'; TextPosition = @('n/a'); ExtLine1Point = @(0.0, 0.0, 0.0); ExtLine2Point = @(3.0, 4.0, 0.0) }))
[void](Add-FakeEntity $geoDoc (New-FakeEntity '1A' 'AcDbRadialDimensionLarge' '0' 1 @{ Measurement = 100.0; TextOverride = ''; TextPosition = @(50.0, 50.0, 0.0); Center = @(0.0, 0.0, 0.0); ChordPoint = @(60.0, 80.0, 0.0) }))
$rows = @{}
foreach ($row in (Invoke-FakeRead $geo 'query' @{ documentId = $documentId }).result.items) { $rows[$row.handle] = $row }
Assert-Equal @(@(@(0, 0), @(10, 0), @(10, 10)), @(0, 1, 0), 5, @(0, 0, -1)) @($rows['10'].vertices, $rows['10'].bulges, $rows['10'].elevation, $rows['10'].normal) 'polylines report bulges, elevation and a flipped normal'
Assert-Equal @(250, 200, $true, $null, $null, 0) @($rows['11'].vertexCount, @($rows['11'].vertices).Count, $rows['11'].verticesTruncated, $rows['11'].bulges, $rows['11'].normal, $long.BulgeCalls) 'long straight polylines inline 200 vertices, flag the rest, and never ask for bulges'
Assert-Equal @(3, 2, @(@(0, 0, 0), @(5, 5, 1))) @($rows['12'].fitPointCount, $rows['12'].controlPointCount, $rows['12'].controlPoints) 'splines report their points'
Assert-Equal @(@(1, 2, 0), @(4, 0, 0), 0.5, 0, 6.283185) @($rows['13'].center, $rows['13'].majorAxis, $rows['13'].ratio, $rows['13'].startParam, $rows['13'].endParam) 'ellipses report their axes and parameters'
Assert-Equal @(2, @(@(0, 0), @(3, 4)), 7) @($rows['14'].vertexCount, $rows['14'].vertices, $rows['14'].elevation) 'old 2D polylines read three values per vertex and keep x, y'
Assert-Equal @(@(0, 0, 1), @(3, 4, 2)) $rows['15'].vertices '3D polylines keep z'
Assert-Equal ('LIVING ROOM ' + [char]0xB2) $rows['16'].text 'MText rows return plain text'
Assert-Equal @('Standard', 12.5, 'middle-center') @($rows['16'].style, $rows['16'].width, $rows['16'].attachment) 'MText rows report style, width and attachment'
Assert-Equal @('ROMANS', 0.8, 90, 'middle-center', @(5, 5, 0)) @($rows['17'].style, $rows['17'].widthFactor, $rows['17'].rotationDeg, $rows['17'].alignment, $rows['17'].alignmentPoint) 'text rows report style, width factor, rotation and alignment'
Assert-Equal @('DIMENSION', 5.9, @(2.95, 1, 0), 0, $null) @($rows['18'].type, $rows['18'].measurement, $rows['18'].textPosition, $rows['18'].rotationDeg, $rows['18'].textOverride) 'rotated dimensions report text position and rotation'
Assert-Equal @(@(0, 0, 0), @(3, 4, 0), '<> m', $null, $true) @($rows['19'].extLine1Point, $rows['19'].extLine2Point, $rows['19'].textOverride, $rows['19'].textPosition, $rows['19'].partial) 'aligned dimensions report extension points and keep them when another property fails'
Assert-Equal @('DIMENSION', @(0, 0, 0), @(60, 80, 0)) @($rows['1A'].type, $rows['1A'].center, $rows['1A'].chordPoint) 'jogged radial dimensions report center and chord point'
Assert-Equal @('16') @((Invoke-FakeRead $geo 'query' @{ documentId = $documentId; textContains = 'living room' }).result.items | ForEach-Object handle) 'MText search ignores format codes'
Assert-Equal 'A {b} 1/2 x\y' (Get-PlainText '\A1;A \{b\} \S1#2; x\\y\L\l') 'MText codes and escapes are stripped'

$interop = Get-InteropPath $InteropSource
Assert-Equal @($true, $false) @(($interop -eq (Get-InteropPath $InteropSource)), ($interop -eq (Get-InteropPath ($InteropSource + ' ')))) 'the interop cache follows the source'

Assert-Equal 'INVALID_REQUEST' (Invoke-FakeRead $acad 'capture' @{ documentId = $documentId; extents = $true; bbox = @{ min = @(0, 0); max = @(1, 1) } }).error.code 'capture takes extents or bbox, not both'
Assert-Equal 'INVALID_REQUEST' (Invoke-FakeRead $acad 'capture' @{ documentId = $documentId; bbox = @{ min = @(0, 0); max = @(5, 0) } }).error.code 'a flat capture bbox is refused'

$cacheBase = $env:LOCALAPPDATA
$env:LOCALAPPDATA = Join-Path ([System.IO.Path]::GetTempPath()) ('inertiacad-interop-' + [guid]::NewGuid().ToString('N'))
try {
  try { Initialize-Interop } catch { Write-Host "Skipping capture: the interop types do not compile here ($_)" }
  if ($null -ne ('InertiaCad.Window' -as [type])) {
    Assert-Equal 'CAPTURE_FAILED' (Invoke-FakeRead $acad 'capture' @{ documentId = $documentId; maxWidth = 100; maxHeight = 100 }).error.code 'capture without a window fails cleanly'
    Assert-Equal @() @($acad.ZoomCalls) 'a plain capture leaves the view alone'
    $doc.Dbmod = 0
    $zoomed = Invoke-FakeRead $acad 'capture' @{ documentId = $documentId; extents = $true }
    Assert-Equal @('CAPTURE_FAILED', @('window', 'previous'), 16) @($zoomed.error.code, @($acad.ZoomCalls), $doc.Dbmod) 'capture zooms to the stored extents without marking system variables changed, restores the view even when the capture fails, and view bits never trip the read check'
    $acad.ZoomCalls.Clear()
    [void](Invoke-FakeRead $acad 'capture' @{ documentId = $documentId; bbox = @{ min = @(10, 0); max = @(0, 10) } })
    Assert-Equal @('window', 'previous') @($acad.ZoomCalls) 'capture zooms to a bbox and restores the view'
    $acad.ZoomCalls.Clear()
    [void](Invoke-FakeRead $acad 'capture' @{ documentId = $documentId; bbox = @{ min = @(-5, -5); max = @(15, 15) } })
    Assert-Equal @('window') @($acad.ZoomCalls) 'a zoom that leaves the view where it was never steps back through the designer''s view history'
    $doc.Dbmod = 0
  }
} finally {
  Remove-Item -LiteralPath $env:LOCALAPPDATA -Recurse -Force -ErrorAction SilentlyContinue
  $env:LOCALAPPDATA = $cacheBase
}

$folder = Join-Path ([System.IO.Path]::GetTempPath()) ('inertiacad-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder | Out-Null
try {
  $source = Join-Path $folder 'Plan.dwg'
  Set-Content -LiteralPath $source -Value 'DWG'
  Assert-Equal 'UNTITLED_DOCUMENT' (Invoke-Fake $acad 'save_copy' @{ documentId = $documentId; path = (Join-Path $folder 'copy.dwg') }).error.code 'untitled drawings are refused'
  $doc.FullName = $source
  $titledId = 'acad:' + $source
  foreach ($bad in 'copy.dwg', '\\server\share\copy.dwg', '\\?\C:\copy.dwg', '\\.\C:\copy.dwg', '\copy.dwg', 'C:copy.dwg', 'C:\inertia\a:b.dwg', (Join-Path $folder 'copy.txt')) {
    Assert-Equal 'INVALID_REQUEST' (Invoke-Fake $acad 'save_copy' @{ documentId = $titledId; path = $bad }).error.code "the copy path $bad is refused"
  }
  $doc.Saved = $false; $doc.Dbmod = 17
  Assert-Equal 'UNSAVED_CHANGES' (Invoke-Fake $acad 'save_copy' @{ documentId = $titledId; path = (Join-Path $folder 'copy.dwg') }).error.code 'unsaved changes are never silently saved'
  $doc.Dbmod = 24
  $copy = (Invoke-Fake $acad 'save_copy' @{ documentId = $titledId; path = (Join-Path $folder 'sub\..\copy.dwg') }).result
  Assert-Equal @((Join-Path $folder 'copy.dwg'), $titledId, 'DWG') @($copy.path, $copy.documentId, [System.IO.File]::ReadAllText((Join-Path $folder 'copy.dwg')).Trim()) 'a drawing changed only by zooming is copied to the normalized path'
  Assert-Equal 'ALREADY_EXISTS' (Invoke-Fake $acad 'save_copy' @{ documentId = $titledId; path = $copy.path }).error.code 'copies never overwrite'
} finally {
  Remove-Item -LiteralPath $folder -Recurse -Force
}

if ($script:Failures -gt 0) { Write-Host "$script:Failures assertion(s) failed"; exit 1 }
Write-Host 'All AutoCAD bridge checks passed'
