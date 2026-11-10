// AI Design Studio 桌面端。
//
// 这一层只做两件事：
//
// 1. 给 `studio-web` 的同一个前端开一个原生窗口（前端资源直接复用 studio-web 的构建产物）；
// 2. 提供一个 `save_file` 命令，把「导出」从浏览器的 `<a download>` 换成原生「另存为」。
//
// 浏览器里导出落到浏览器自己的下载目录，用户看不见也管不着；桌面端让用户自己
// 选目录与文件名，存完把真实路径回报给界面。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 弹原生「另存为」对话框并把内容写到用户选中的位置。
///
/// 返回 `Some(路径)` 表示已落盘，`None` 表示用户取消。
///
/// `contents` 走 base64：IPC 的 JSON 通道传裸二进制会被展开成数字数组，一张 PNG
/// 能顶到几十万个数字，base64 是这里最省事也最稳的编码。
#[tauri::command]
async fn save_file(app: AppHandle, name: String, contents: String) -> Result<Option<String>, String> {
    let bytes = BASE64
        .decode(contents.as_bytes())
        .map_err(|error| format!("内容解码失败：{error}"))?;
    let suggested = sanitize_file_name(&name);
    let extension = suggested
        .rsplit_once('.')
        .map(|(_, extension)| extension.trim().to_lowercase())
        .filter(|extension| !extension.is_empty() && extension.len() <= 8);

    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        // 这两个 builder 方法是 `#[must_use]`：不接住返回值就等于没设。
        let mut builder = handle.dialog().file();
        builder = builder.set_file_name(&suggested);
        if let Some(extension) = extension.as_deref() {
            builder = builder.add_filter(&format!("{extension} 文件"), &[extension]);
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|error| format!("打开保存对话框失败：{error}"))?;

    // 用户取消不是错误：返回 None，界面据此把提示改成「已取消」。
    let Some(picked) = picked else {
        return Ok(None);
    };
    let target: PathBuf = picked
        .into_path()
        .map_err(|error| format!("无法解析保存路径：{error}"))?;
    std::fs::write(&target, &bytes)
        .map_err(|error| format!("写入 {} 失败：{error}", target.display()))?;
    Ok(Some(target.to_string_lossy().to_string()))
}

/// 把界面传来的文件名收拾成能直接当默认文件名用的样子。
///
/// 只留文件名本身（挡掉路径分隔符）、去掉控制字符；空文件名退回一个兜底名。
fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base.chars().filter(|character| !character.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "导出文件".to_string()
    } else {
        trimmed.to_string()
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_file])
        .run(tauri::generate_context!())
        .expect("AI Design Studio 桌面端启动失败");
}

#[cfg(test)]
mod tests {
    use super::sanitize_file_name;

    #[test]
    fn 文件名只保留最后一段() {
        assert_eq!(sanitize_file_name("C:\\Users\\me\\首页.html"), "首页.html");
        assert_eq!(sanitize_file_name("dir/sub/首页.html"), "首页.html");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
    }

    #[test]
    fn 控制字符被去掉但中文与扩展名保留() {
        assert_eq!(sanitize_file_name("首页\n.html"), "首页.html");
        assert_eq!(sanitize_file_name("导出 文件.pdf"), "导出 文件.pdf");
    }

    #[test]
    fn 空名字与纯空白退回兜底名() {
        assert_eq!(sanitize_file_name(""), "导出文件");
        assert_eq!(sanitize_file_name("   "), "导出文件");
    }
}
