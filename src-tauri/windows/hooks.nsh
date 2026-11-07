!macro NSIS_HOOK_PREINSTALL
  ; Tutup proses Migi lama jika sedang berjalan agar file update tidak terkunci
  nsExec::Exec 'taskkill /F /IM Migi.exe'
  nsExec::Exec 'taskkill /F /IM migi.exe'
!macroend

