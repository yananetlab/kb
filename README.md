# 个人学习记录

在线访问：[yananetlab.github.io/kb](https://yananetlab.github.io/kb/)

学习记录工具，支持每日任务、额外学习、学习笔记、日历、统计、JSON备份和GitHub跨设备同步。

每日打卡位于统计上方，手机端使用任务卡片和大按钮。工作日另预留60分钟工作间隙，学习内容自主安排，可完成或跳过；这部分时间单独统计，不分摊到两科。

## 使用与修改

直接用浏览器打开learning_tracker.html即可使用，无需安装依赖。github-sync.js需要与HTML放在同一个文件夹。

未连接同步时，学习记录仅保存在当前浏览器的localStorage中，也可以导出、导入JSON备份。

## 手机与电脑同步

1. 创建私有仓库yananetlab/kb-data，并勾选Add a README file。网页代码仍放在原来的公开仓库kb中。
2. 创建[Fine-grained访问令牌](https://github.com/settings/personal-access-tokens/new?name=kb-study-sync&target_name=yananetlab&expires_in=180&contents=write)：Repository access选择Only select repositories，只授权kb-data；Repository permissions中的Contents设为Read and write。
3. 在学习网页顶部点“连接同步”，填写yananetlab/kb-data和令牌，点“保存并同步”。手机和电脑分别配置一次，后续自动同步。

记录保存为私有仓库中的study-records.json，格式与原有JSON备份相同。页面打开、切回前台或恢复网络时会同步，停留在页面时约每15秒检查一次。输入学习时长或笔记期间会暂缓同步，离开输入框后继续；断网时仍可打卡，联网后补传。

首次连接会合并当前设备与GitHub的已有记录，空白设备不会清空云端。同步按任务、笔记和额外学习分别合并；同一项同时被两边改成不同内容时，需要在页面上选择保留哪份。GitHub的文件SHA用于检测同时写入，遇到冲突会重新读取和合并。

令牌只保存在配置它的浏览器中，不会写入仓库、网页源码、记录文件或导出的JSON备份；到期后在“同步设置”中更新。断开同步会移除此设备保存的令牌，本地和GitHub中的学习记录都会保留。首次接收云端修改前会在本机保留一份旧记录快照。

同步使用[GitHub Contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)，浏览器直接通过HTTPS访问GitHub，无需另开服务器。

验证同步逻辑：

```text
node --test tests/github-sync.test.cjs
```

## 发布

推送到main分支后，GitHub Actions自动部署到GitHub Pages。仓库Settings→Pages中的Source应选择GitHub Actions。

发布流程将learning_tracker.html同时输出为默认首页index.html和原文件名，并复制github-sync.js，因此以下两个地址均可打开：

- https://yananetlab.github.io/kb/
- https://yananetlab.github.io/kb/learning_tracker.html
