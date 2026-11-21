# Exercises the AutoCAD bridge against a small fake of AutoCAD's COM objects.
# Run with: pwsh -NoProfile -File src/server/cad/hosts/autocad/InertiaCadBridge.Tests.ps1
# (Windows PowerShell 5.1 works too.) Real-host behaviour still needs AutoCAD.
$ErrorActionPreference = 'Stop'
$env:INERTIA_CAD_BRIDGE_TEST = '1'
. (Join-Path $PSScriptRoot 'InertiaCadBridge.ps1')

$script:Failures = 0
function Assert-Equal($Expected, $Actual, [string]$Message) {
  $left = ConvertTo-Json -InputObject $Expected -Depth 8 -Compress
  $right = ConvertTo-Json -InputObject $Actual -Depth 8 -Compress
  if ($left -ne $right) {
    $script:Failures++
    Write-Host "FAIL: $Message`n  expected $left`n  actual   $right"
  }
}

class FakeCollection : System.Collections.IEnumerable {
  [System.Collections.ArrayList]$Items = (New-Object System.Collections.ArrayList)
  [scriptblock]$Factory
  [object] Add([string]$Name) { $item = & $this.Factory $Name; [void]$this.Items.Add($item); return $item }
  [object] Item([int]$Index) { return $this.Items[$Index] }
  [int] get_Count() { return $this.Items.Count }
  [System.Collections.IEnumerator] GetEnumerator() { return $this.Items.GetEnumerator() }
}

function New-FakeEntity([string]$Handle, [string]$ObjectName, [string]$Layer, [string]$Owner, [hashtable]$Properties = @{}) {
  $entity = [pscustomobject]@{ Handle = $Handle; ObjectName = $ObjectName; Layer = $Layer; Color = 256; OwnerID = $Owner; Deleted = $false }
  foreach ($key in $Properties.Keys) { Add-Member -InputObject $entity -NotePropertyName $key -NotePropertyValue $Properties[$key] }
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Move -Value {
    param($From, $To)
    foreach ($name in 'StartPoint', 'EndPoint', 'InsertionPoint', 'Center') {
      if ($null -ne $this.$name) { $point = $this.$name; $this.$name = @(($point[0] + $To[0] - $From[0]), ($point[1] + $To[1] - $From[1]), ($point[2] + $To[2] - $From[2])) }
    }
  }
  Add-Member -InputObject $entity -MemberType ScriptMethod -Name Delete -Value { $this.Deleted = $true }
  return $entity
}

function New-FakeAutoCAD {
  $registry = @{}
  $layers = [FakeCollection]::new()
  $layers.Factory = { param($Name) [pscustomobject]@{ Name = $Name; Lock = $false; Color = 7 } }
  [void]$layers.Add('0'); [void]$layers.Add('A-WALL'); [void]$layers.Add('A-ANNO')
  ($layers.Items | Where-Object Name -eq 'A-ANNO').Lock = $false
  $locked = $layers.Add('LOCKED'); $locked.Lock = $true

  $doc = [pscustomobject]@{
    Name = 'Plan.dwg'; FullName = ''; Saved = $true; ReadOnly = $false; Layers = $layers
    Layouts = @([pscustomobject]@{ Name = 'Model'; Block = [pscustomobject]@{ ObjectID = 1 } }, [pscustomobject]@{ Name = 'A1'; Block = [pscustomobject]@{ ObjectID = 2 } })
    Undo = (New-Object System.Collections.ArrayList); Registry = $registry; NextHandle = 500; Pickfirst = @()
    ActiveLayout = [pscustomobject]@{ Name = 'Model' }
  }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name GetVariable -Value { param($Name) switch ($Name) { 'INSUNITS' { 4 } 'DWGTITLED' { $(if ($this.FullName) { 1 } else { 0 }) } } }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name StartUndoMark -Value { [void]$this.Undo.Add('start') }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name EndUndoMark -Value { [void]$this.Undo.Add('end') }
  Add-Member -InputObject $doc -MemberType ScriptMethod -Name HandleToObject -Value {
    param($Handle)
    $entity = $this.Registry[$Handle]
    if ($null -eq $entity -or $entity.Deleted) { throw 'Unknown handle' }
    return $entity
  }
  Add-Member -InputObject $doc -MemberType ScriptProperty -Name PickfirstSelectionSet -Value {
    $items = @($this.Pickfirst | ForEach-Object { $this.Registry[$_] })
    $set = [pscustomobject]@{ Entities = $items; Count = $items.Count }
    Add-Member -InputObject $set -MemberType ScriptMethod -Name Item -Value { param($Index) $this.Entities[$Index] }
    return $set
  }
  $selectionSets = [pscustomobject]@{ Doc = $doc }
  Add-Member -InputObject $selectionSets -MemberType ScriptMethod -Name Add -Value {
    param($Name)
    $set = [pscustomobject]@{ Doc = $this.Doc; Entities = @(); Count = 0 }
    Add-Member -InputObject $set -MemberType ScriptMethod -Name Select -Value {
      param($Mode, $P1, $P2, $Codes, $Values)
      $all = @($this.Doc.Registry.Values | Where-Object { -not $_.Deleted -and $_.OwnerID -eq 1 } | Sort-Object Handle)
      for ($i = 0; $i -lt @($Codes).Count; $i++) {
        $value = $Values[$i]
        switch ($Codes[$i]) {
          0 { $types = $value -split ','; $all = @($all | Where-Object { $types -contains (Get-ShortType $_.ObjectName) }) }
          8 { $all = @($all | Where-Object { $_.Layer -like $value }) }
        }
      }
      $this.Entities = $all
      $this.Count = $all.Count
    }
    Add-Member -InputObject $set -MemberType ScriptMethod -Name Item -Value { param($Index) $this.Entities[$Index] }
    Add-Member -InputObject $set -MemberType ScriptMethod -Name Delete -Value { }
    return $set
  }
  Add-Member -InputObject $doc -MemberType NoteProperty -Name SelectionSets -Value $selectionSets
  $space = [pscustomobject]@{ Doc = $doc }
  $addEntity = {
    param($Space, $ObjectName, $Properties)
    $Space.Doc.NextHandle++
    $handle = '{0:X}' -f $Space.Doc.NextHandle
    $entity = New-FakeEntity $handle $ObjectName '0' 1 $Properties
    $Space.Doc.Registry[$handle] = $entity
    return $entity
  }
  Add-Member -InputObject $space -MemberType NoteProperty -Name AddEntity -Value $addEntity
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddLine -Value { param($Start, $End) & $this.AddEntity $this 'AcDbLine' @{ StartPoint = $Start; EndPoint = $End } }
  Add-Member -InputObject $space -MemberType ScriptMethod -Name AddCircle -Value { param($Center, $Radius) & $this.AddEntity $this 'AcDbCircle' @{ Center = $Center; Radius = $Radius } }
  Add-Member -InputObject $doc -MemberType NoteProperty -Name ModelSpace -Value $space

  $registry['1A'] = New-FakeEntity '1A' 'AcDbLine' 'A-WALL' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(1000.0, 0.0, 0.0); Length = 1000.0 }
  $registry['1B'] = New-FakeEntity '1B' 'AcDbLine' 'A-WALL' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(0.0, 500.0, 0.0); Length = 500.0 }
  $registry['2C'] = New-FakeEntity '2C' 'AcDbText' 'A-ANNO' 1 @{ TextString = 'KITCHEN'; InsertionPoint = @(10.0, 10.0, 0.0); Height = 250.0 }
  $registry['3D'] = New-FakeEntity '3D' 'AcDbLine' 'A-WALL' 99 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(1.0, 1.0, 0.0) }
  $registry['4E'] = New-FakeEntity '4E' 'AcDbLine' 'LOCKED' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(2.0, 2.0, 0.0) }
  $attribute = [pscustomobject]@{ TagString = 'REV'; TextString = 'A' }
  $title = New-FakeEntity '5F' 'AcDbBlockReference' '0' 2 @{ Name = 'TITLE'; EffectiveName = 'TITLE'; HasAttributes = $true; InsertionPoint = @(0.0, 0.0, 0.0); Rotation = 0.0; XScaleFactor = 1.0; YScaleFactor = 1.0; ZScaleFactor = 1.0; Attribute = $attribute }
  Add-Member -InputObject $title -MemberType ScriptMethod -Name GetAttributes -Value { , @($this.Attribute) }
  $registry['5F'] = $title
  $doc.Pickfirst = @('1A', '2C', '5F')

  $acad = [pscustomobject]@{ Version = '25.0s (LMS Tech)'; Name = 'AutoCAD'; Documents = @($doc); ActiveDocument = $doc }
  return $acad
}

function Invoke-Fake($Acad, [string]$Method, $Params) {
  $raw = ConvertTo-Json -InputObject ([ordered]@{ id = 'r1'; method = $Method; params = $Params }) -Depth 10 -Compress
  $json = Invoke-Request $raw { $Acad }.GetNewClosure()
  return $json | ConvertFrom-Json
}

$script:Approvals = New-Object System.Collections.ArrayList
$script:Answer = $true
function Request-Approval([string]$Message) { [void]$script:Approvals.Add($Message); return $script:Answer }

$acad = New-FakeAutoCAD
$doc = $acad.ActiveDocument
$documentId = 'acad:Plan.dwg'

$documents = (Invoke-Fake $acad 'documents' @{}).result.documents
Assert-Equal $documentId $documents[0].documentId 'documents carry an id built from the drawing name'
Assert-Equal 'mm' $documents[0].displayUnits 'INSUNITS 4 is millimetres'

$selection = (Invoke-Fake $acad 'selection' @{ documentId = $documentId }).result
Assert-Equal 3 $selection.total 'selection reads the pickfirst set'
Assert-Equal @('Model', 'Model', 'A1') @($selection.items | ForEach-Object layout) 'rows name their layout'
Assert-Equal 'A' $selection.items[2].attributes[0].value 'block attributes are listed'

$query = (Invoke-Fake $acad 'query' @{ documentId = $documentId; types = @('line'); limit = 1 }).result
Assert-Equal 3 $query.total 'query filters by DXF type'
Assert-Equal '1' $query.nextCursor 'query pages with a cursor'
$texts = (Invoke-Fake $acad 'query' @{ documentId = $documentId; textContains = 'kitch' }).result
Assert-Equal @('2C') @($texts.items | ForEach-Object handle) 'query searches text'

Assert-Equal 'UNSUPPORTED_OPERATION' (Invoke-Fake $acad 'send_command' @{ command = 'ERASE ALL' }).error.code 'arbitrary commands are refused'
Assert-Equal 'NESTED_TARGET' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_layer'; handles = @('3D'); layer = 'A-ANNO' }) }).error.code 'block-definition contents are refused'
Assert-Equal 'LOCKED' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_color'; handles = @('4E'); color = 1 }) }).error.code 'locked layers are refused'
Assert-Equal 'LAYER_NOT_FOUND' (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = @(@{ op = 'acad.set_layer'; handles = @('1A'); layer = 'NEW' }) }).error.code 'unknown layers are refused'

$operations = @(@{ op = 'acad.create_layer'; name = 'A-DEMO'; color = 1 }, @{ op = 'acad.set_layer'; handles = @('1A', '1B'); layer = 'A-DEMO' })
$preview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $operations }).result
Assert-Equal 3 @($preview.changes).Count 'preview lists every change'
Assert-Equal 'A-WALL' $doc.Registry['1A'].Layer 'preview does not change the drawing'

$script:Answer = $false
$rejected = (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $operations; expectedFingerprints = $preview.fingerprints; approvalMessage = 'Apply?' }).result
Assert-Equal 'rejected' $rejected.status 'a declined dialog applies nothing'
Assert-Equal 0 $doc.Undo.Count 'a declined dialog opens no undo group'

$script:Answer = $true
$applied = (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $operations; expectedFingerprints = $preview.fingerprints; approvalMessage = 'Apply?' }).result
Assert-Equal 'applied' $applied.status 'an approved change applies'
Assert-Equal @('A-DEMO', 'A-DEMO') @($doc.Registry['1A'].Layer, $doc.Registry['1B'].Layer) 'both lines moved to the new layer'
Assert-Equal @('start', 'end') @($doc.Undo) 'the change is one undo group'
Assert-Equal @('Apply?', 'Apply?') @($script:Approvals) 'the dialog shows the server message'

$moveOps = @(@{ op = 'acad.move'; handles = @('2C'); vector = @(5, 0) })
$movePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $moveOps }).result
$doc.Registry['2C'].TextString = 'PANTRY'
$approvalsBefore = $script:Approvals.Count
Assert-Equal 'TARGET_CHANGED' (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $moveOps; expectedFingerprints = $movePreview.fingerprints; approvalMessage = 'Move?' }).error.code 'a target edited after preview is refused'
Assert-Equal $approvalsBefore $script:Approvals.Count 'a stale change never reaches the dialog'

$attributeOps = @(@{ op = 'acad.set_attribute'; handles = @('5F'); tag = 'rev'; value = 'B' })
$attributePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $attributeOps }).result
[void](Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $attributeOps; expectedFingerprints = $attributePreview.fingerprints; approvalMessage = 'Rev?' })
Assert-Equal 'B' $doc.Registry['5F'].Attribute.TextString 'attribute values update by tag'

$lineOps = @(@{ op = 'acad.add_line'; start = @(0, 0); end = @(100, 0, 0); layer = 'A-DEMO' })
$linePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $lineOps }).result
$created = (Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $lineOps; expectedFingerprints = $linePreview.fingerprints; approvalMessage = 'Line?' }).result.created
Assert-Equal 'LINE' $created[0].type 'new lines report their handle and type'
Assert-Equal 'A-DEMO' $doc.Registry[$created[0].handle].Layer 'new lines land on the requested layer'

$eraseOps = @(@{ op = 'acad.erase'; handles = @('1B') }, @{ op = 'acad.set_color'; handles = @('1A'); color = 3 })
$erasePreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $eraseOps }).result
Add-Member -InputObject $doc.Registry['1A'] -MemberType ScriptProperty -Name Color -Value { 256 } -SecondValue { throw 'eDuplicateRecordName' } -Force
$doc.Undo.Clear()
$partial = Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $eraseOps; expectedFingerprints = $erasePreview.fingerprints; approvalMessage = 'Erase?' }
Assert-Equal 'PARTIALLY_APPLIED' $partial.error.code 'a failure after the first step is reported honestly'
Assert-Equal @('start', 'end') @($doc.Undo) 'a failed apply still closes its undo group'

$doc.Registry['1A'] = New-FakeEntity '1A' 'AcDbLine' 'A-WALL' 1 @{ StartPoint = @(0.0, 0.0, 0.0); EndPoint = @(1000.0, 0.0, 0.0) }
$roundTrip = @(@{ op = 'acad.set_layer'; handles = @('1A'); layer = 'A-ANNO' }, @{ op = 'acad.set_layer'; handles = @('1A'); layer = 'A-WALL' })
$roundTripPreview = (Invoke-Fake $acad 'preview' @{ documentId = $documentId; operations = $roundTrip }).result
Assert-Equal @('A-WALL', 'A-ANNO') @($roundTripPreview.changes | ForEach-Object before) 'a later layer change sees the earlier one'
[void](Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $roundTrip; expectedFingerprints = $roundTripPreview.fingerprints; approvalMessage = 'Round trip?' })
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
$failed = Invoke-Fake $acad 'apply' @{ documentId = $documentId; operations = $colorOps; expectedFingerprints = $colorPreview.fingerprints; approvalMessage = 'Layer?' }
Assert-Equal 'APPLY_FAILED' $failed.error.code 'a step that fails after creating something removes it and reports nothing changed'
Assert-Equal $null (Get-Layer $doc 'A-BROKEN') 'the half-made layer is gone'

$folder = Join-Path ([System.IO.Path]::GetTempPath()) ('inertiacad-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder | Out-Null
try {
  $source = Join-Path $folder 'Plan.dwg'
  Set-Content -LiteralPath $source -Value 'DWG'
  Assert-Equal 'UNTITLED_DOCUMENT' (Invoke-Fake $acad 'save_copy' @{ documentId = $documentId; path = (Join-Path $folder 'copy.dwg') }).error.code 'untitled drawings are refused'
  $doc.FullName = $source
  $titledId = 'acad:' + $source
  $doc.Saved = $false
  Assert-Equal 'UNSAVED_CHANGES' (Invoke-Fake $acad 'save_copy' @{ documentId = $titledId; path = (Join-Path $folder 'copy.dwg') }).error.code 'unsaved changes are never silently saved'
  $doc.Saved = $true
  $copy = (Invoke-Fake $acad 'save_copy' @{ documentId = $titledId; path = (Join-Path $folder 'copy.dwg') }).result
  Assert-Equal $true (Test-Path -LiteralPath $copy.path) 'a saved drawing is copied'
  Assert-Equal 'ALREADY_EXISTS' (Invoke-Fake $acad 'save_copy' @{ documentId = $titledId; path = $copy.path }).error.code 'copies never overwrite'
} finally {
  Remove-Item -LiteralPath $folder -Recurse -Force
}

if ($script:Failures -gt 0) { Write-Host "$script:Failures assertion(s) failed"; exit 1 }
Write-Host 'All AutoCAD bridge checks passed'
