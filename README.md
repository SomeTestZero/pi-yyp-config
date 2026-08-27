# pi-yyp-config

yyp 的个人 pi 配置包：extensions / skills / prompts / themes，一处维护，多环境同步。

## 安装

```bash
# SSH
pi install git:git@github.com:SomeTestZero/pi-yyp-config

# 或 HTTPS
pi install git:github.com/SomeTestZero/pi-yyp-config

# 固定到某个 tag
pi install git:git@github.com:SomeTestZero/pi-yyp-config@v1
```

## 更新

```bash
pi update --extensions   # 同步所有包的最新提交
```

## 目录结构

```
extensions/   # 扩展（.ts/.js）
skills/       # 技能（SKILL.md 目录或 .md 文件）
prompts/      # 提示词模板（.md）
themes/       # 主题（.json）
```

## 当前包含

| 资源 | 说明 |
| --- | --- |
| `extensions/wheel-scroll.ts` | 全屏模式滚轮速度修复，`/wheel <n>` 设置每次滚动的行数（默认 3） |
