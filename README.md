# @local/dsh-session-isolation

Host + 浏览器半侧的 bundle。为指定工作区里**新建**的会话分配独立工作目录：

```
<workspace>\<baseDir>\<session-id>
```

默认 `baseDir` 为 `_sessions`，所以默认工作区里的新会话工作目录是
`<默认工作区>\_sessions\<session-id>`。会话仍归属原工作区（`SessionHeader.cwd`
不变，侧栏分组不变），只是 `working-directory` 投影被切换到该目录。

会话窗口右上角的工具区还会出现一个**文件夹按钮**（在「在应用中打开」旁），
点击即可在系统文件管理器里打开当前会话的独立目录；没有独立目录的会话
（旧会话、其他工作区）不显示该按钮。

## 安装

本包是 DeepSeek Harness 的**本地 bundle**（不在 npm 上发布）：DSH 的插件管理器把
本目录链接进当前 profile，由 bundle 自带的 `cordis.patch.yml` 插入 Host 行。

1. 把本仓库放到一个固定目录，例如 `D:\dsh-session-isolation`。
2. 编辑 [cordis.patch.yml](cordis.patch.yml)，把 `workspaces` 里的示例路径换成你的
   工作区根（绝对路径；Windows 路径在 YAML 里写双反斜杠）。
3. 用插件管理器安装本地 bundle，然后重启 DSH 桌面版：

```
plugin_manager install_bundle target=<本仓库目录>
```

桌面版「插件」页面也支持从本地目录安装。要求 DSH 已启用
`@deepseek-ai/dsh-working-directory` 与浏览器模块系统（桌面版 / web 默认启用）。

## 配置

`cordis.patch.yml` 里插入的 `session-isolation` 行：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `workspaces` | `string[]` | 必填 | 绝对路径；只有 `header.cwd` 与其中一项相等的会话才会被隔离 |
| `baseDir` | `string` | `_sessions` | 相对路径时相对每个 workspace，绝对路径时直接使用 |
| `isolateSubagents` | `boolean` | `true` | 为子代理会话也创建独立目录 |

配置非法时插件在激活阶段直接抛错（行显示失败），不会静默失效。

## 浏览器按钮的工作方式

按钮不猜路径，而是向本插件的 Host 路由查询：

```
GET /session-isolation/session-directory?sessionId=<id>
  -> 200 {"sessionId": "...", "directory": "..."}   已隔离且目录存在
  -> 404                                              未隔离 / 目录已删
```

路由和状态栏目使用同一套信任栅栏（Host/Origin 检查 + 浏览器鉴权），并且只报告
本插件为配置工作区会话创建的目录。拿到路径后，按钮复用 desktop profile 自带的
`GET /open-in-app/apps` 与 `POST /open-in-app/open` 打开文件管理器；Windows 下
等价于用资源管理器打开该目录。

## 文件地址纠错（v1.2.0）

DSH 的浏览器端在建文件地址时假设「会话工作目录 == 工作区根」。隔离会话里工作目录是
`_sessions\<id>`，于是聊天里的文件链接/文件卡可能生成两类坏地址：

- 缺分隔符：`.../default-workspace_sessions/session-<id>/a.md`（工作区根与 `baseDir` 粘在一起）；
- 按工作目录取相对路径：`a.md`，Host 却按工作区根解析成 `<workspace>\a.md`。

本插件的浏览器半侧会包一层 `sidebarRight.openResource`，在打开前修正这两类地址：
已知工作区根 + `baseDir` 粘连时补 `/`；相对路径且 Host 路由确认会话已被隔离时，
补成 `<baseDir>/<session-id>/<路径>`。修正只发生在「配置工作区 + 已隔离」的会话里，
其他地址原样放行；包装幂等，出错只写 warn，不影响打开动作。

注意：修复只作用于重启后新打开的文件。之前已经持久化的坏 tab 地址不会自动改写，
重新点一次文件即可。此功能需要重启 DSH 桌面版（浏览器半侧是构建产物）。

## 行为边界

- 只在 `agent/created` 且 `source` 为 `startup`（新会话）或 `clear`（同一会话重开新对话）时切换目录；`resume` / `compact` 不动，已有投影按回放恢复。
- 不覆盖别的机制已经设置过的目录：`startup` 时若当前目录既不是工作区根、也不是服务默认目录，则跳过。
- 隔离过程任何异常都只写 warn 日志，绝不回滚会话创建。
- 不做启动扫描，不迁移旧会话：安装前已存在的会话保持原地。
- 删除会话可能留下空的 `_sessions\<id>` 目录，不自动清理。
- Headless 组合里没有 `webServer` 等宿主服务时，隔离照常工作，只是没有按钮。

## 验证

1. 新会话日志 `session.v4.jsonl.zstd` 中出现 `working-directory/change` 事件，`cwd` 指向 `_sessions\<session-id>`。
2. 系统提示中的 `Current working directory` 是该目录。
3. 非配置工作区（例如 `D:\work\another-workspace`）的新会话不产生 `_sessions` 目录。
4. 恢复默认工作区的旧会话不追加变更事件。
5. 会话头部出现文件夹按钮，点击后文件管理器打开 `_sessions\<session-id>`。
6. 已隔离会话里点聊天中的文件链接/文件卡，右侧预览正常打开（v1.2.0 起自动纠正坏地址）。

## 停用 / 卸载

插件管理器中禁用 `session-isolation` 行即可停止对新会话生效；`remove_bundle`
移除整个 bundle。历史会话与 `_sessions` 目录都不受影响（目录可手工删除）。

本包只 import `node:` 内置模块，无运行时依赖。修改 Host 侧（`index.js`）或
浏览器侧（`client.js`）后都需要重启 DSH 桌面版；浏览器侧是普通脚本
（`dsh.client` 声明），由模块系统按 `exports["./client"]` 提供。

## License

MIT，见 [LICENSE](LICENSE)。
