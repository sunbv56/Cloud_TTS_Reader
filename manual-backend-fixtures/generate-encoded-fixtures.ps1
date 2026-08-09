param(
    [string]$OutputDirectory = $PSScriptRoot
)

$content = @"
Chương 1: Khởi đầu
Tôi yêu tiếng Việt. Đây là câu đầu tiên của chương một.

===

Chương 2: Thử nghiệm
Ứng dụng đọc đúng dấu và không làm hỏng ký tự.

===

Chương 3: Kết quả
Kết quả mong đợi là ba chương và nội dung rõ ràng.
"@

[System.IO.File]::WriteAllText(
    (Join-Path $OutputDirectory 'backend-fixture-utf8-bom.txt'),
    $content,
    [System.Text.UTF8Encoding]::new($true)
)
[System.IO.File]::WriteAllText(
    (Join-Path $OutputDirectory 'backend-fixture-utf16.txt'),
    $content,
    [System.Text.UnicodeEncoding]::new($false, $true)
)
$windows1258Content = @"
Chuong 1: Đê Ơ
Noi dung: Â Ô Ư Ă ơ ê.

===

Chuong 2: Kiem tra
Backend phai doc dung byte Windows-1258.

===

Chuong 3: Ket qua
Khong duoc xuat hien dau hoi thay cho ky tu.
"@
[System.IO.File]::WriteAllText(
    (Join-Path $OutputDirectory 'backend-fixture-windows-1258.txt'),
    $windows1258Content,
    [System.Text.Encoding]::GetEncoding(1258)
)

Write-Output "Generated encoded fixtures in $OutputDirectory"
