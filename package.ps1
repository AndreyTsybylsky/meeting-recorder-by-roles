# Meet Transcriber Packaging Script
# This script bundles the extension into a ZIP file for distribution.

if (!(Test-Path -Path "dist")) {
    New-Item -ItemType Directory -Path "dist" | Out-Null
}

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$zipName = "dist/Meet-Transcriber-v1.1-$timestamp.zip"

Write-Host "Packaging extension to $zipName..."

# Get all files and folders excluding git and build artifacts
$include = Get-ChildItem -Path . -Exclude ".git", ".gitignore", "package.ps1", "dist", "*.pem", "*.txt"

if ($include) {
    Compress-Archive -Path $include -DestinationPath $zipName -Force
    Write-Host "Done! Share the ZIP file from the 'dist' folder with your colleagues."
} else {
    Write-Error "No files found to package."
}
