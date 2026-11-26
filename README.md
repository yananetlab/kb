# 个人学习记录

在线访问：[yananetlab.github.io/kb](https://yananetlab.github.io/kb/)

单文件学习记录工具，支持每日任务、额外学习、学习笔记、日历、统计和JSON备份。

## 使用与修改

直接用浏览器打开learning_tracker.html即可使用，无需安装依赖。

学习记录保存在当前浏览器的localStorage中。更换设备或访问地址时，可以通过“导出备份JSON”和“导入备份JSON”迁移记录；不同设备之间不会自动同步。

## 发布

推送到main分支后，GitHub Actions自动部署到GitHub Pages。仓库Settings→Pages中的Source应选择GitHub Actions。

发布流程将learning_tracker.html同时输出为默认首页index.html和原文件名，因此以下两个地址均可打开：

- https://yananetlab.github.io/kb/
- https://yananetlab.github.io/kb/learning_tracker.html
