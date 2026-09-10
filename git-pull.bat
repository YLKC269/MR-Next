@echo off
chcp 65001 >nul
title MR-Next : git pull
cd /d "X:\ComfyUI_portable_TE\ComfyUI_portable_TE_v260619\MR-Next"
if errorlevel 1 goto fail
echo ============================================
echo  MR-Next  ^|  git pull
echo  dir: %CD%
echo ============================================
echo.
echo [1/2] before:
git status -sb
echo.
echo [2/2] pulling...
git pull
echo.
echo ============================================
echo  Done. Press any key to close.
echo ============================================
pause >nul
exit /b 0

:fail
echo [X] Cannot open directory:
echo     X:\ComfyUI_portable_TE\ComfyUI_portable_TE_v260619\MR-Next
pause >nul
exit /b 1
