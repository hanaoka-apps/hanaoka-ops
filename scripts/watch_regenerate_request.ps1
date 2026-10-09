<#
.SYNOPSIS
  互換用の入口。本体は rpa_queue_worker.ps1 (RPAジョブの順番待ち処理)。

.DESCRIPTION
  RPA専用機のタスクスケジューラー(「Hanaoka 再集計リクエスト監視」)は、このファイルを
  ログオン時に起動している。タスクを登録し直さなくて済むよう、名前を残して本体を呼ぶだけにした。
  旧方式の合図ファイル(_regenerate_request.json)も本体が sales_master の依頼として受け付ける。
#>
& (Join-Path $PSScriptRoot 'rpa_queue_worker.ps1')
