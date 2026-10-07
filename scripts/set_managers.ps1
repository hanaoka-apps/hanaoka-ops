<#
  Entra の「マネージャー」(上司) をまとめて入れる
  ------------------------------------------------------------
  組織図・連絡先ページは Entra の manager を読んで階層を作る。
  誰が誰の上司かはここ(Entra)にだけ置き、HTML やリポジトリには書かない。
  対象は 有効・ライセンスあり・メンバー のアカウント（ページと同じ）。
  共有PC用のアカウントは、Entra の「従業員の種類」(employeeType) を 共有PC にして外す。

  必要なもの
    PowerShell 7 (pwsh) と Microsoft Graph PowerShell (Microsoft.Graph.Users)

  上司の欄には UPN でも名前でも書ける。名前は空白を除いた表示名の先頭一致で探す
  （「花岡尚」→ 花岡 尚）。1人に決まらないときは止まって候補を出す。

  手順
    1) 表を作る（Entra を読むだけ）
         pwsh -File scripts/set_managers.ps1 -Prepare
       → data/上司_部署ルール.csv … Entra にある部署の一覧。「部署の上司」を書く
       → data/上司_対応表.csv     … 1人1行。今の上司と、新しい上司
    2) data/上司_部署ルール.csv に、部署ごとの上司を書いて保存し、もう一度 -Prepare
       → 対応表の「新しい上司」が空の行に、その部署の上司が入る（本人が上司の行は空のまま）
         手で書いた行は上書きしない
    3) data/上司_対応表.csv で、部署の上司たち自身の行（上司の上司）などを書く
    4) 確認（書き換えない）     pwsh -File scripts/set_managers.ps1
    5) 書き込む                 pwsh -File scripts/set_managers.ps1 -Apply
  「新しい上司」が空の行は何もしない（今の上司を消すことはしない）。
#>
param(
  [switch]$Prepare,
  [switch]$Apply,
  [string]$Dir = (Join-Path $PSScriptRoot '..\data')
)
$ErrorActionPreference = 'Stop'
$TenantId = '3933e8a0-c945-4e97-ae67-c82131087cad'
# Users を先に読み込む（set_mobile_phones.ps1 と同じ。Graph モジュールの版ずれ対策）
Import-Module Microsoft.Graph.Users
$RuleFile = Join-Path $Dir '上司_部署ルール.csv'
$MapFile  = Join-Path $Dir '上司_対応表.csv'

$scope = if ($Apply) { 'User.ReadWrite.All' } else { 'User.Read.All' }
Connect-MgGraph -TenantId $TenantId -Scopes $scope -NoWelcome

$users = @(Get-MgUser -All -Property 'id,displayName,userPrincipalName,department,jobTitle,accountEnabled,userType,assignedLicenses,employeeType' -ExpandProperty manager |
  Where-Object { $_.UserType -eq 'Member' -and $_.AccountEnabled -and $_.AssignedLicenses.Count -gt 0 -and $_.EmployeeType -ne '共有PC' })
$byId = @{}; $users | ForEach-Object { $byId[$_.Id] = $_ }

function Resolve-Person([string]$s, [string]$where) {
  $s = "$s".Trim()
  if (-not $s) { return $null }
  if ($s -match '@') {
    $hit = @($users | Where-Object { $_.UserPrincipalName -ieq $s })
  } else {
    $key = $s -replace '\s', ''
    $hit = @($users | Where-Object { ($_.DisplayName -replace '\s', '') -like "$key*" })
  }
  if ($hit.Count -eq 1) { return $hit[0] }
  $c = if ($hit.Count) { ($hit | ForEach-Object { "$($_.DisplayName) <$($_.UserPrincipalName)>" }) -join ' / ' } else { '見つからない' }
  throw "$where の「$s」が1人に決まりません（$c）。UPN で書くか、名前を長くしてください。"
}
function Mgr-Name($u) { if ($u.Manager -and $byId[$u.Manager.Id]) { $byId[$u.Manager.Id].DisplayName } else { '' } }
function Dept($u) { if ("$($u.Department)".Trim()) { "$($u.Department)".Trim() } else { '（空欄）' } }

if ($Prepare) {
  New-Item -ItemType Directory -Force $Dir | Out-Null

  # 部署ルール：無ければ Entra の部署から作る。あれば読む（新しい部署は足す）
  $rules = @{}
  if (Test-Path $RuleFile) { Import-Csv $RuleFile -Encoding utf8 | ForEach-Object { $rules[$_.部署] = $_.部署の上司 } }
  $ruleRows = $users | Group-Object { Dept $_ } | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{ 部署 = $_.Name; 人数 = $_.Count; 部署の上司 = "$($rules[$_.Name])" }
  }
  $ruleRows | Export-Csv $RuleFile -Encoding utf8BOM -NoTypeInformation

  # 対応表：手で書いた「新しい上司」は残す
  $kept = @{}
  if (Test-Path $MapFile) { Import-Csv $MapFile -Encoding utf8 | ForEach-Object { if ($_.新しい上司.Trim()) { $kept[$_.UPN.ToLower()] = $_.新しい上司 } } }
  $heads = @{}
  foreach ($r in $ruleRows) { if ($r.部署の上司.Trim()) { $heads[$r.部署] = Resolve-Person $r.部署の上司 "部署ルール（$($r.部署)）" } }

  $rows = $users | Sort-Object { Dept $_ }, DisplayName | ForEach-Object {
    $u = $_; $new = $kept[$u.UserPrincipalName.ToLower()]
    if (-not $new) {
      $h = $heads[(Dept $u)]
      if ($h -and $h.Id -ne $u.Id) { $new = $h.DisplayName }
    }
    [pscustomobject]@{
      表示名     = $u.DisplayName
      UPN        = $u.UserPrincipalName
      部署       = Dept $u
      役職       = $u.JobTitle
      今の上司   = Mgr-Name $u
      新しい上司 = "$new"
    }
  }
  $rows | Export-Csv $MapFile -Encoding utf8BOM -NoTypeInformation
  $filled = @($rows | Where-Object { $_.新しい上司 }).Count
  Write-Host "部署ルール: $RuleFile （$(@($ruleRows).Count) 部署）"
  Write-Host "対応表:     $MapFile （$(@($rows).Count) 人、新しい上司あり $filled 人）"
  return
}

# ---- 確認 / 書き込み ----
if (-not (Test-Path $MapFile)) { throw "対応表がありません: $MapFile （先に -Prepare を実行）" }
$plan = @{}   # 社員Id → 上司Id（書き込み後の姿）
$users | ForEach-Object { if ($_.Manager) { $plan[$_.Id] = $_.Manager.Id } }
$changes = foreach ($r in (Import-Csv $MapFile -Encoding utf8)) {
  if (-not $r.新しい上司.Trim()) { continue }
  $u = Resolve-Person $r.UPN "対応表の UPN"
  $m = Resolve-Person $r.新しい上司 "$($r.表示名) の新しい上司"
  if ($m.Id -eq $u.Id) { throw "$($u.DisplayName) の上司が本人になっています" }
  $plan[$u.Id] = $m.Id
  [pscustomobject]@{ User = $u; Mgr = $m }
}

# 上司をたどって本人に戻ってこないか（A→B→A のような輪）
foreach ($id in @($plan.Keys)) {
  $seen = @($id); $cur = $plan[$id]
  while ($cur) {
    if ($seen -contains $cur) { throw "上司の関係が輪になっています: $(($seen + $cur | ForEach-Object { $byId[$_].DisplayName }) -join ' → ')" }
    $seen += $cur; $cur = $plan[$cur]
  }
}

foreach ($c in $changes) {
  $u = $c.User; $m = $c.Mgr; $cur = Mgr-Name $u
  if ($u.Manager -and $u.Manager.Id -eq $m.Id) { Write-Host "  そのまま  $($u.DisplayName) ← $($m.DisplayName)"; continue }
  if ($Apply) {
    Set-MgUserManagerByRef -UserId $u.Id -BodyParameter @{ '@odata.id' = "https://graph.microsoft.com/v1.0/users/$($m.Id)" }
    Write-Host "  更新      $($u.DisplayName)  '$cur' → '$($m.DisplayName)'"
  } else {
    Write-Host "  変更予定  $($u.DisplayName)  '$cur' → '$($m.DisplayName)'"
  }
}
$none = @($users | Where-Object { -not $plan[$_.Id] })
Write-Host "`n上司なしのまま: $($none.Count) 人  $(($none | ForEach-Object DisplayName) -join '、')"
if (-not $Apply) { Write-Host "確認のみです。書き込むときは -Apply を付けて実行してください。" }
