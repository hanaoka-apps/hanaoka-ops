<#
  給与の従業員基本情報から、Entra の「入社日」(employeeHireDate) を入れる
  ------------------------------------------------------------
  組織図・連絡先ページは、部署の中を入社日の早い順に並べる（入社日は画面には出さない）。
  入社日は Entra にだけ置き、HTML やリポジトリには書かない。給与の CSV から写すのは
  「氏名」と「入社日」の2つだけで、ほかの列（給与・住所など）は読んでも使わず、どこにも書かない。

  必要なもの
    PowerShell 7 (pwsh) と Microsoft Graph PowerShell (Microsoft.Graph.Users)
    入社日の読み書きには User-LifeCycleInfo.Read.All / ReadWrite.All の権限が要る
    （サインインのときに同意を求められたら、管理者として同意する）

  手順
    1) 対応表を作る（Entra を読むだけ）。給与の CSV は複数まとめて渡せる（本社・工場）
         pwsh -File scripts/set_hire_dates.ps1 -Prepare -Source "…\9月\従業員基本情報_*.csv"
         （* で本社・工場をまとめて指定できる）
       → data/入社日_対応表.csv（data/ は .gitignore 済み）
         ・列は見出しで探す：氏名＝「氏名」を含む列（カナは除く）、入社日＝「入社」を含む列
           違うときは -NameColumn / -DateColumn で見出しを指定する
         ・Entra の表示名と氏名を突き合わせる（空白・姓名の順・髙/高 などの字体の違いは無視）
           決まらない人は「新しい入社日」が空のまま。手で書けばよい（2010/04/01 の形）
    2) 確認（書き換えない）     pwsh -File scripts/set_hire_dates.ps1
    3) 書き込む                 pwsh -File scripts/set_hire_dates.ps1 -Apply
  「新しい入社日」が空の行は何もしない。
#>
param(
  [switch]$Prepare,
  [string[]]$Source,
  [string]$NameColumn,
  [string]$DateColumn,
  [switch]$Apply,
  [string]$Map = (Join-Path $PSScriptRoot '..\data\入社日_対応表.csv')
)
$ErrorActionPreference = 'Stop'
$TenantId = '3933e8a0-c945-4e97-ae67-c82131087cad'
# Users を先に読み込む（Graph モジュールの版ずれ対策。ほかのスクリプトと同じ）
Import-Module Microsoft.Graph.Users

$scopes = if ($Apply) { 'User.ReadWrite.All', 'User-LifeCycleInfo.ReadWrite.All' } else { 'User.Read.All', 'User-LifeCycleInfo.Read.All' }
Connect-MgGraph -TenantId $TenantId -Scopes $scopes -NoWelcome

$users = @(Get-MgUser -All -Property 'id,displayName,userPrincipalName,department,accountEnabled,userType,assignedLicenses,employeeType,employeeHireDate' |
  Where-Object { $_.UserType -eq 'Member' -and $_.AccountEnabled -and $_.AssignedLicenses.Count -gt 0 -and $_.EmployeeType -ne '共有PC' })

# 名前の突き合わせ用：空白を除き、全角半角をそろえ、よくある字体の違いを1つにする
$Variant = @{ '髙' = '高'; '﨑' = '崎'; '齊' = '斉'; '齋' = '斉'; '斎' = '斉'; '邊' = '辺'; '邉' = '辺'; '濱' = '浜'; '櫻' = '桜'; '德' = '徳'; '廣' = '広'; '澤' = '沢'; '國' = '国'; '眞' = '真' }
function NameKey([string]$s) {
  $t = "$s".Normalize([Text.NormalizationForm]::FormKC) -replace '[\s　]', ''
  ($t.ToCharArray() | ForEach-Object { $c = [string]$_; if ($Variant.ContainsKey($c)) { $Variant[$c] } else { $c } }) -join ''
}
function NameKeys([string]$s) {
  $keys = @(NameKey $s)
  $parts = @("$s".Trim() -split '[\s　]+' | Where-Object { $_ })
  if ($parts.Count -eq 2) { $keys += NameKey ($parts[1] + $parts[0]) }   # 「雅 花岡」のような逆順
  $keys
}

# 日付：2010/04/01・2010-4-1・20100401・平成22年4月1日・H22.4.1 など
function Parse-Date([string]$s) {
  $t = "$s".Normalize([Text.NormalizationForm]::FormKC).Trim()
  if (-not $t) { return $null }
  if ($t -match '^(\d{4})[/\-\.年](\d{1,2})[/\-\.月](\d{1,2})') { return '{0:0000}-{1:00}-{2:00}' -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3] }
  if ($t -match '^(\d{4})(\d{2})(\d{2})$') { return '{0}-{1}-{2}' -f $Matches[1], $Matches[2], $Matches[3] }
  $era = @{ 'R' = 2018; '令和' = 2018; 'H' = 1988; '平成' = 1988; 'S' = 1925; '昭和' = 1925 }
  if ($t -match '^(令和|平成|昭和|[RHS])\s*(\d{1,2}|元)[/\-\.年](\d{1,2})[/\-\.月](\d{1,2})') {
    $y = if ($Matches[2] -eq '元') { 1 } else { [int]$Matches[2] }
    return '{0:0000}-{1:00}-{2:00}' -f ($era[$Matches[1].ToUpper()] + $y), [int]$Matches[3], [int]$Matches[4]
  }
  return $null
}

if ($Prepare) {
  if (-not $Source) { throw '-Source に給与の従業員基本情報の CSV を指定してください（複数可）' }
  # pwsh -File で渡すと、カンマ区切りの複数指定が1つの文字列で届く。分けてから、* も使えるように展開する
  $Source = @($Source | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().Trim('"').Trim() } | Where-Object { $_ } |
    ForEach-Object { if ($_ -match '[\*\?]') { (Get-ChildItem -Path $_ -File).FullName } else { $_ } })
  if (-not $Source) { throw '-Source のファイルが見つかりません' }
  $pay = @{}   # 名前のキー → @{ 氏名; 入社日 }。同じキーが2人いれば $null（決めない）
  foreach ($f in $Source) {
    # Excel で開いたままでも読めるように、書き込み中の共有を許して開く（読むだけ）
    $fs = [System.IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
    try { $text = (New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::GetEncoding(932))).ReadToEnd() } finally { $fs.Dispose() }
    $rows = @($text | ConvertFrom-Csv)
    if (-not $rows.Count) { continue }
    $cols = $rows[0].PSObject.Properties.Name
    $nc = if ($NameColumn) { $NameColumn } else { $cols | Where-Object { $_ -match '氏名' -and $_ -notmatch 'カナ|ｶﾅ|かな|フリガナ|ﾌﾘｶﾞﾅ' } | Select-Object -First 1 }
    $dc = if ($DateColumn) { $DateColumn } else { $cols | Where-Object { $_ -match '入社' } | Select-Object -First 1 }
    if (-not $nc -or -not $dc) { throw "$f ：氏名か入社日の列が見つかりません。-NameColumn / -DateColumn で見出しを指定してください（見出し：$($cols -join ', ')）" }
    Write-Host "$(Split-Path $f -Leaf)：氏名＝「$nc」、入社日＝「$dc」、$($rows.Count) 行"
    foreach ($r in $rows) {
      $name = "$($r.$nc)".Trim(); if (-not $name) { continue }
      $d = Parse-Date "$($r.$dc)"
      foreach ($k in (NameKeys $name)) {
        if ($pay.ContainsKey($k) -and $pay[$k] -and $pay[$k].氏名 -ne $name) { $pay[$k] = $null }
        elseif (-not $pay.ContainsKey($k)) { $pay[$k] = @{ 氏名 = $name; 入社日 = $d } }
      }
    }
  }

  $out = foreach ($u in ($users | Sort-Object Department, DisplayName)) {
    $hit = $null
    foreach ($k in (NameKeys $u.DisplayName)) { if ($pay.ContainsKey($k)) { $hit = $pay[$k]; break } }
    [pscustomobject]@{
      表示名       = $u.DisplayName
      UPN          = $u.UserPrincipalName
      部署         = $u.Department
      今の入社日   = if ($u.EmployeeHireDate) { $u.EmployeeHireDate.ToString('yyyy-MM-dd') } else { '' }
      新しい入社日 = if ($hit) { "$($hit.入社日)" } else { '' }
      給与の氏名   = if ($hit) { $hit.氏名 } else { '（見つからない・同名あり）' }
    }
  }
  New-Item -ItemType Directory -Force (Split-Path $Map) | Out-Null
  $out | Export-Csv $Map -Encoding utf8BOM -NoTypeInformation
  $ok = @($out | Where-Object { $_.新しい入社日 }).Count
  Write-Host "対応表を作りました: $Map  ($(@($out).Count) 人、入社日あり $ok 人)。空の人は Excel で書き足してください。"
  return
}

# ---- 確認 / 書き込み ----
if (-not (Test-Path $Map)) { throw "対応表がありません: $Map （先に -Prepare を実行）" }
$byUpn = @{}; $users | ForEach-Object { $byUpn[$_.UserPrincipalName.ToLower()] = $_ }
foreach ($r in (Import-Csv $Map -Encoding utf8)) {
  if (-not "$($r.新しい入社日)".Trim()) { continue }
  $new = Parse-Date $r.新しい入社日
  if (-not $new) { Write-Host "  日付が読めない  $($r.表示名)  '$($r.新しい入社日)'（飛ばします）"; continue }
  $u = $byUpn["$($r.UPN)".Trim().ToLower()]
  if (-not $u) { Write-Host "  見つからない  $($r.表示名) <$($r.UPN)>（飛ばします）"; continue }
  $cur = if ($u.EmployeeHireDate) { $u.EmployeeHireDate.ToString('yyyy-MM-dd') } else { '' }
  if ($cur -eq $new) { Write-Host "  そのまま  $($u.DisplayName)  $new"; continue }
  if ($Apply) {
    # 日本時間の0時にすると UTC で前日になるので、UTC の0時として入れる
    Update-MgUser -UserId $u.Id -EmployeeHireDate ([datetime]::SpecifyKind([datetime]::ParseExact($new, 'yyyy-MM-dd', $null), 'Utc'))
    Write-Host "  更新      $($u.DisplayName)  '$cur' → '$new'"
  } else {
    Write-Host "  変更予定  $($u.DisplayName)  '$cur' → '$new'"
  }
}
if (-not $Apply) { Write-Host "`n確認のみです。書き込むときは -Apply を付けて実行してください。" }
