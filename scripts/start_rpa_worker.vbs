' RPA senyouki no jouchu script wo, gamen wo dasazu ni kidou suru (Task Scheduler kara yobu).
' powershell.exe -WindowStyle Hidden ya conhost.exe --headless wa, kono PC de wa tsukaenakatta:
'   - Windows Terminal ga kitei no terminal da to gamen ga mie, tojiru to jouchu script mo shuuryou suru
'   - conhost --headless wa Task Scheduler kara kidou suru to PowerShell wo ugokasazu ni shuuryou shita
' Run(..., 0, True): saisho kara hihyouji (SW_HIDE) de kidou shi, shuuryou made matsu
' (task ga "jikkouchuu" no mama ni nari, nijuu kidou boushi ga kiku).
Dim fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\watch_regenerate_request.ps1""", 0, True
