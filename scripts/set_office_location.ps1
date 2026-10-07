<#
  Entra の「勤務地」(officeLocation) をまとめて入れる
  ------------------------------------------------------------
  組織図・連絡先ページは、勤務地で一覧を「本社」「工場」に分ける。
  同じ部署でも人によって勤務地が違うことがある（総務部など）ので、人ごとに入れる。
  誰がどこかは Entra にだけ置き、HTML やリポジトリには書かない。
  対象は 有効・ライセンスあり・メンバー のアカウント（共有PCは除く。ページと同じ）。

  必要なもの
    PowerShell 7 (pwsh) と Microsoft Graph PowerShell (Microsoft.Graph.Users)

  手順
    1) 表を作る（Entra を読むだけ）
         pwsh -File scripts/set_office_location.ps1 -Prepare
       → data/勤務地_部署ルール.csv … 部署ごとの勤務地（無ければ部署の一覧から作る）
       → data/勤務地_対応表.csv     … 1人1行。今の勤務地と、新しい勤務地
         「新しい勤務地」の空欄に、部署ルールの勤務地が入る。手で書いた行は上書きしない
    2) 部署ルールを書いたら、もう一度 -Prepare。部署と違う勤務地の人は対応表で直す
    3) 確認（書き換えない）     pwsh -File scripts/set_office_location.ps1
    4) 書き込む                 pwsh -File scripts/set_office_location.ps1 -Apply
  「新しい勤務地」が空の行は何もしない。
#>
param(
  [switch]$Prepare,
  [switch]$Apply,
  [string]$Dir = (Join-Path $PSScriptRoot '..\data')
)
$ErrorActionPreference = 'Stop'
$TenantId = '3933e8a0-c945-4e97-ae67-c82131087cad'
# Users を先に読み込む（Graph モジュールの版ずれ対策。ほかのスクリプトと同じ）
Import-Module Microsoft.Graph.Users
$RuleFile = Join-Path $Dir '勤務地_部署ルール.csv'
$MapFile  = Join-Path $Dir '勤務地_対応表.csv'

$scope = if ($Apply) { 'User.ReadWrite.All' } else { 'User.Read.All' }
Connect-MgGraph -TenantId $TenantId -Scopes $scope -NoWelcome

$users = @(Get-MgUser -All -Property 'id,displayName,userPrincipalName,department,officeLocation,accountEnabled,userType,assignedLicenses,employeeType' |
  Where-Object { $_.UserType -eq 'Member' -and $_.AccountEnabled -and $_.AssignedLicenses.Count -gt 0 -and $_.EmployeeType -ne '共有PC' })
function Dept($u) { if ("$($u.Department)".Trim()) { "$($u.Department)".Trim() } else { '（空欄）' } }

if ($Prepare) {
  New-Item -ItemType Directory -Force $Dir | Out-Null
  $rules = @{}
  if (Test-Path $RuleFile) { Import-Csv $RuleFile -Encoding utf8 | ForEach-Object { $rules[$_.部署] = "$($_.勤務地)".Trim() } }
  $ruleRows = $users | Group-Object { Dept $_ } | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{ 部署 = $_.Name; 人数 = $_.Count; 勤務地 = "$($rules[$_.Name])" }
  }
  $ruleRows | Export-Csv $RuleFile -Encoding utf8BOM -NoTypeInformation

  $kept = @{}
  if (Test-Path $MapFile) { Import-Csv $MapFile -Encoding utf8 | ForEach-Object { if ($_.新しい勤務地.Trim()) { $kept[$_.UPN.ToLower()] = $_.新しい勤務地.Trim() } } }
  $rows = $users | Sort-Object { Dept $_ }, DisplayName | ForEach-Object {
    $new = $kept[$_.UserPrincipalName.ToLower()]
    if (-not $new) { $new = $rules[(Dept $_)] }
    [pscustomobject]@{
      表示名       = $_.DisplayName
      UPN          = $_.UserPrincipalName
      部署         = Dept $_
      今の勤務地   = "$($_.OfficeLocation)"
      新しい勤務地 = "$new"
    }
  }
  $rows | Export-Csv $MapFile -Encoding utf8BOM -NoTypeInformation
  $filled = @($rows | Where-Object { $_.新しい勤務地 }).Count
  Write-Host "部署ルール: $RuleFile （$(@($ruleRows).Count) 部署）"
  Write-Host "対応表:     $MapFile （$(@($rows).Count) 人、新しい勤務地あり $filled 人）"
  return
}

# ---- 確認 / 書き込み ----
if (-not (Test-Path $MapFile)) { throw "対応表がありません: $MapFile （先に -Prepare を実行）" }
$byUpn = @{}; $users | ForEach-Object { $byUpn[$_.UserPrincipalName.ToLower()] = $_ }
foreach ($r in (Import-Csv $MapFile -Encoding utf8)) {
  $new = "$($r.新しい勤務地)".Trim()
  if (-not $new) { continue }
  $u = $byUpn["$($r.UPN)".Trim().ToLower()]
  if (-not $u) { Write-Host "  見つからない  $($r.表示名) <$($r.UPN)>（飛ばします）"; continue }
  $cur = "$($u.OfficeLocation)".Trim()
  if ($cur -eq $new) { Write-Host "  そのまま  $($u.DisplayName)  $new"; continue }
  if ($Apply) {
    Update-MgUser -UserId $u.Id -OfficeLocation $new
    Write-Host "  更新      $($u.DisplayName)  '$cur' → '$new'"
  } else {
    Write-Host "  変更予定  $($u.DisplayName)  '$cur' → '$new'"
  }
}
if (-not $Apply) { Write-Host "`n確認のみです。書き込むときは -Apply を付けて実行してください。" }
