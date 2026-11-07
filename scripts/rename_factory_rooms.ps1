<#
  工場の会議室の名前を変える（2026-11 の改名）
  ------------------------------------------------------------
  会議室予約アプリ（room_reserve.html）は、会議室の名前を Outlook（Exchange）から
  そのまま読んでいる。だから、ここで Outlook 側の表示名を変えれば、アプリの一覧も変わる。
  メールアドレスは変えない（変えると、数時間〜1日 空き情報が読めなくなるため）。

    工場 3F 第二研修室（大） → 工場 3F ROOM G-1
    工場 3F 第一研修室（小） → 工場 3F ROOM G-2
    工場 3F 特別会議室       → 工場 3F ROOM A
    工場 3F 応接室           → 工場 3F ROOM H
    工場 1F 第一会議室       → 工場 1F ROOM L
    工場 1F 商談A・商談B は廃止
  頭の「工場 3F」は本社の部屋（頭に「本社」が付いている）と書き方をそろえるために付ける。

  本社の部屋も同じ書き方にそろえる（2026-11-07 追加）：
    本社 3F会議室（LD-3） → 本社 3F LD-3   … 「会議室」と括弧を外す
  この形に当てはまらない本社の部屋は、変えずに「★対象外」と出す。

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

# 部屋はメールアドレスで決める（アドレスは変えないので、名前が何度変わっても同じ部屋に当たる）。
# 2026-11-07 に「工場」なしの ROOM G-1 などで一度書き込んだが、頭に「工場 3F」を付け直すことにした。
# Old は画面に出すための元の名前。
$Renames = @(
  @{ Mail = 'room-fac-3f-03@hanaoka-corp.co.jp'; Old = '第二研修室（大）'; New = '工場 3F ROOM G-1'; Floor = 3 }
  @{ Mail = 'room-fac-3f-02@hanaoka-corp.co.jp'; Old = '第一研修室（小）'; New = '工場 3F ROOM G-2'; Floor = 3 }
  @{ Mail = 'room-fac-3f-01@hanaoka-corp.co.jp'; Old = '特別会議室';       New = '工場 3F ROOM A';   Floor = 3 }
  @{ Mail = 'room-fac-3f-04@hanaoka-corp.co.jp'; Old = '応接室';           New = '工場 3F ROOM H';   Floor = 3 }
  @{ Mail = 'room-fac-1f-01@hanaoka-corp.co.jp'; Old = '第一会議室';       New = '工場 1F ROOM L';   Floor = 1 }
)
$Retired = @('room-fac-1f-02@hanaoka-corp.co.jp', 'room-fac-1f-03@hanaoka-corp.co.jp')   # 商談A・商談B

# 全角・半角、空白、括弧の違いで取りこぼさないようにそろえる
function Norm([string]$s) {
  $s = $s.Normalize([Text.NormalizationForm]::FormKC)   # 全角英数・全角括弧 → 半角
  ($s -replace '[\s　]', '').ToLower()
}

$rooms = @(Get-EXOMailbox -RecipientTypeDetails RoomMailbox -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, HiddenFromAddressListsEnabled)
Write-Host "会議室のメールボックス: $($rooms.Count) 室`n"

function Find-Room([string]$mail) {
  $hit = @($rooms | Where-Object { "$($_.PrimarySmtpAddress)" -eq $mail })
  return , $hit
}

$ng = 0
Write-Host '工場'
foreach ($r in $Renames) {
  $hit = Find-Room $r.Mail
  if ($hit.Count -ne 1) {
    $ng++
    Write-Host "  ★止めます  元「$($r.Old)」<$($r.Mail)> が見つからない"
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

# ---- 本社：「本社 3F会議室（LD-3）」→「本社 3F LD-3」（工場と書き方をそろえる） ----
# 「会議室」と括弧を外す。括弧の中（LD-3 など）が新しい名前になる。
# アプリは予定の場所に書かれた「LD-3」やアドレス（room-3f-ld3@）でも部屋を見分けるので、
# 古い名前で入っている予約も、これまでどおりその部屋の予約として出る。
Write-Host "`n本社"
$hq = @($rooms | Where-Object { $_.DisplayName -like '本社*' } | Sort-Object { "$($_.PrimarySmtpAddress)" })
foreach ($m in $hq) {
  $cur = "$($m.DisplayName)"
  $mt = [regex]::Match($cur, '^本社\s*(\d+)\s*[FＦ]\s*会議室\s*[（(]\s*(.+?)\s*[)）]\s*$')
  if (-not $mt.Success) {
    $already = $cur -match '^本社 \d+F \S'
    Write-Host ("  {0}  '{1}' <{2}>" -f $(if ($already) { 'そのまま' } else { '★対象外' }), $cur, $m.PrimarySmtpAddress)
    if (-not $already) { $ng++ }
    continue
  }
  $kc = [Text.NormalizationForm]::FormKC                 # 全角の数字・英字・記号を半角にそろえる
  $new = "本社 $($mt.Groups[1].Value.Normalize($kc))F $($mt.Groups[2].Value.Normalize($kc))"
  if ($Apply) {
    Set-Mailbox -Identity $m.PrimarySmtpAddress -DisplayName $new
    Write-Host "  更新      '$cur' → '$new' <$($m.PrimarySmtpAddress)>"
  } else {
    Write-Host "  変更予定  '$cur' → '$new' <$($m.PrimarySmtpAddress)>"
  }
}
$others = @($rooms | Where-Object { $_.DisplayName -notlike '本社*' -and "$($_.PrimarySmtpAddress)" -notlike 'room-fac-*' })
foreach ($m in $others) { Write-Host "  ★対象外  '$($m.DisplayName)' <$($m.PrimarySmtpAddress)>（本社でも工場でもない名前）"; $ng++ }

Write-Host ''
$roomLists =@(Get-DistributionGroup -RecipientTypeDetails RoomList -ResultSize Unlimited)
foreach ($mail in $Retired) {
  $hit = Find-Room $mail
  if ($hit.Count -ne 1) { Write-Host "  廃止      <$mail> が見つからない（もう片付いている？）"; continue }
  $m = $hit[0]
  if ($m.HiddenFromAddressListsEnabled) { Write-Host "  そのまま  $($m.DisplayName) <$mail>（もうアドレス帳から隠してある）"; continue }
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
  Write-Host "`n★ $ng 室は名前を変えていません（★の行）。会議室をすべて出します。"
  $rooms |
    Sort-Object { "$($_.PrimarySmtpAddress)" } |
    ForEach-Object { Write-Host "    $($_.PrimarySmtpAddress)  …  $($_.DisplayName)" }
}
if (-not $Apply) { Write-Host "`n確認のみです。書き込むときは -Apply を付けて実行してください。" }
Write-Host "Outlook とアプリに新しい名前が出るまで、数時間〜1日かかることがあります。"
