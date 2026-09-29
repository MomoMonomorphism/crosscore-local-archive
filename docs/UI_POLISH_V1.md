# UI polish v1

工作分支：`ui-polish-v1`。默认保留三栏、黑橙风格和黑底舞台。

## 本次改动

- 角色目录：统一 64px 头像，突出角色名；次要信息最多两行，完整内容仍在原有 title 中。选中态使用低饱和橙色底、侧边线和箭头；搜索框有明确边界。
- 右侧工具：将收起操作移到独立标题行，保留三个完整标签；削弱状态区和按钮的强橙色面积。编号降为辅助信息，保留有区别的交互说明，重复的通用点击提示合并到公共说明。
- 收起体验：桌面端 48px 展开边栏；保存桌面左右面板状态，移动抽屉不覆盖桌面偏好；恢复布局按钮继续有效。关闭/展开面板时维护键盘焦点。
- CSS 主体只作用于非沉浸的角色页面。CG、插画、ASMR 的独立布局、Spine 运行层、热区几何、小游戏脚本、音频和资源文件不做改写。共用面板 hook 的桌面状态记忆适用于使用该 hook 的页面。

## 代码位置

`web/src/galleryPolish.css` 是最后加载的独立样式层；`useGalleryLayout.ts` 从原 `GalleryLayout.tsx` 拆出，原导出路径保持兼容；`galleryPanelPreferences.ts` 单独验证和存储面板偏好，不改写角色/播放状态存储。

## 验证与预览

在仓库根目录运行：

```sh
cd web
npm ci
node --experimental-strip-types check-gallery-preferences.ts
npm run build
npm run build:pages
cd ..
python -m http.server 4173 --bind 127.0.0.1 --directory dist-pages
```

浏览器打开 `http://127.0.0.1:4173/`。默认 base 为 `/`，不需要本地游戏后端即可预览仓库内的 Pages 演示包；不是完整本地资源库。

人工检查：1440/1920 桌面三栏；右栏收起与重新展开；刷新后保持；恢复布局；跨 1100px 断点与手机横竖屏；搜索、切换角色/形态、热区定位、动作、台词与沉浸模式。测试脚本运行成功不等于所有小游戏已完成回归验收。

本分支不合并 main、不更改 Pages 部署工作流、不主动部署线上站点。
