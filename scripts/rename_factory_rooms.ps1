<#
  工場の会議室の名前を変える（2026-11 の改名）
  ------------------------------------------------------------
  会議室予約アプリ（room_reserve.html）は、会議室の名前を Outlook（Exchange）から
  そのまま読んでいる。だから、ここで Outlook 側の表示名を変えれば、アプリの一覧も変わる。
  メールアドレスは変えない（変えると、数時間〜1日 空き情報が読めなくなるため）。

    3F  第一研修室（大） → ROOM G-1
    3F  第一研修室（小） → ROOM G-2
    3F  特別会議室       → ROOM A
    3F  応接室           → ROOM H
    1F  第一会議室       → ROOM L
    商談A・商談B は廃止

  廃止の2室は消さない。-Retire を付けたときだけ「アドレス帳に出さない」にして、
  会議室の一覧（RoomList）から外す。予定表と予約の記録は残るので、あとで戻せる。

  必要なもの
    PowerShell 7 (pwsh) と ExchangeOnlineManagement モジュール、Exchange の管理者権限

  手順
    1) 確認（書き換えない）        pwsh -File scripts/rename_factory_rooms.ps1
    2) 名前を変える                pwsh -File scripts/rename_factory_rooms.ps1 -Apply
    3) 廃止の2室も片付ける         pwsh -File scripts/rename_factory_rooms.ps1 -Apply -Retire
  2回目以降に実行しても、変更済みの部屋は「そのまま」と出るだけ。
#>
param(
  [switch]$Apply,
  [switch]$Retire
)
$ErrorActionPreference = 'Stop'
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -ShowBanner:$false

# 今の名前 → 新しい名前。今の名前は「含まれていればよい」（前に「工場」などが付いていても拾う）
$Renames = @(
  @{ Old = '第一研修室（大）'; New = 'ROOM G-1'; Floor = 3 }
  @{ Old = '第一研修室（小）'; New = 'ROOM G-2'; Floor = 3 }
  @{ Old = '特別会議室';       New = 'ROOM A';   Floor = 3 }
  @{ Old = '応接室';           New = 'ROOM H';   Floor = 3 }
  @{ Old = '第一会議室';       New = 'ROOM L';   Floor = 1 }
)
$Retired = @('商談A', '商談B')

# 全角・半角、空白、括弧の違いで取りこぼさないようにそろえる
function Norm([string]$s) {
  $s = $s.Normalize([Text.NormalizationForm]::FormKC)   # 全角英数・全角括弧 → 半角
  ($s -replace '[\s　]', '').ToLower()
}

$rooms = @(Get-EXOMailbox -RecipientTypeDetails RoomMailbox -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, HiddenFromAddressListsEnabled)
Write-Host "会議室のメールボックス: $($rooms.Count) 室`n"

function Find-Room([string]$name, [string]$new) {
  $key = Norm $name
  $hit = @($rooms | Where-Object { (Norm $_.DisplayName).Contains($key) })
  # 本社にも同じ名前の部屋があるときは、工場のアドレス（factory-）を優先する
  if ($hit.Count -gt 1) {
    $fac = @($hit | Where-Object { "$($_.PrimarySmtpAddress)" -like 'factory*' })
    if ($fac.Count -ge 1) { $hit = $fac }
  }
  # 名前を変えたあとにもう一度実行したとき用
  if ($hit.Count -eq 0 -and $new) { $hit = @($rooms | Where-Object { (Norm $_.DisplayName) -eq (Norm $new) }) }
  return , $hit
}

$ng = 0
foreach ($r in $Renames) {
  $hit = Find-Room $r.Old $r.New
  if ($hit.Count -ne 1) {
    $ng++
    $c = if ($hit.Count) { ($hit | ForEach-Object { "$($_.DisplayName) <$($_.PrimarySmtpAddress)>" }) -join ' / ' } else { '見つからない' }
    Write-Host "  ★止めます  「$($r.Old)」に当たる部屋が $($hit.Count) 室: $c"
    continue
  }
  $m = $hit[0]
  if ($m.DisplayName -ceq $r.New) { Write-Host "  そのまま  $($r.New) <$($m.PrimarySmtpAddress)>"; continue }
  if ($Apply) {
    Set-Mailbox -Identity $m.PrimarySmtpAddress -DisplayName $r.New
    Set-Place   -Identity $m.PrimarySmtpAddress -Floor $r.Floor -FloorLabel "$($r.Floor)F"
    Write-Host "  更新      '$($m.DisplayName)' → '$($r.New)'（$($r.Floor)F） <$($m.PrimarySmtpAddress)>"
  } else {
    Write-Host "  変更予定  '$($m.DisplayName)' → '$($r.New)'（$($r.Floor)F） <$($m.PrimarySmtpAddress)>"
  }
}

Write-Host ''
$roomLists = @(Get-DistributionGroup -RecipientTypeDetails RoomList -ResultSize Unlimited)
foreach ($name in $Retired) {
  $hit = Find-Room $name $null
  if ($hit.Count -ne 1) {
    $c = if ($hit.Count) { ($hit | ForEach-Object { "$($_.DisplayName) <$($_.PrimarySmtpAddress)>" }) -join ' / ' } else { '見つからない（もう片付いている？）' }
    Write-Host "  廃止      「$name」: $c"
    continue
  }
  $m = $hit[0]
  $inLists = @($roomLists | Where-Object {
    @(Get-DistributionGroupMember -Identity $_.Identity -ResultSize Unlimited | Where-Object { "$($_.PrimarySmtpAddress)" -eq "$($m.PrimarySmtpAddress)" }).Count
  })
  if (-not $Retire) {
    Write-Host "  廃止予定  $($m.DisplayName) <$($m.PrimarySmtpAddress)>（-Retire を付けると、アドレス帳から隠して会議室の一覧 $($inLists.Count) 件から外す）"
    continue
  }
  if (-not $Apply) {
    Write-Host "  廃止予定  $($m.DisplayName) <$($m.PrimarySmtpAddress)>（アドレス帳から隠す・会議室の一覧 $($inLists.Count) 件から外す）"
    continue
  }
  if (-not $m.HiddenFromAddressListsEnabled) { Set-Mailbox -Identity $m.PrimarySmtpAddress -HiddenFromAddressListsEnabled $true }
  foreach ($l in $inLists) { Remove-DistributionGroupMember -Identity $l.Identity -Member $m.PrimarySmtpAddress -BypassSecurityGroupManagerCheck -Confirm:$false }
  Write-Host "  廃止      $($m.DisplayName) <$($m.PrimarySmtpAddress)>（アドレス帳から隠した・会議室の一覧 $($inLists.Count) 件から外した）"
}

if ($ng) {
  Write-Host "`n★ $ng 室が特定できませんでした。工場の部屋（room-fac-）をすべて出します。今の名前を確かめてください。"
  $rooms | Where-Object { "$($_.PrimarySmtpAddress)" -like 'room-fac-*' -or "$($_.PrimarySmtpAddress)" -like 'factory*' } |
    Sort-Object { "$($_.PrimarySmtpAddress)" } |
    ForEach-Object { Write-Host "    $($_.PrimarySmtpAddress)  …  $($_.DisplayName)" }
}
if (-not $Apply) { Write-Host "`n確認のみです。書き込むときは -Apply を付けて実行してください。" }
Write-Host "Outlook とアプリに新しい名前が出るまで、数時間〜1日かかることがあります。"
