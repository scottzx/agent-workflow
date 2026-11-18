# CodeBuddy Code

- Built-in name: `codebuddy`
- Default command: `codebuddy --acp`
- Package: [@tencent-ai/codebuddy-code](https://www.npmjs.com/package/@tencent-ai/codebuddy-code)
- Upstream: [ACP protocol integration](https://cloud.tencent.com.cn/document/product/1831/137021)

`acpx codebuddy` launches the installed `codebuddy` CLI as an ACP stdio server. Install the CLI and finish its own terminal login before using it through acpx. acpx does not start CodeBuddy's login flow, does not call `authenticate` for it, and does not read a CodeBuddy API key. A session fails if the CLI has not already signed in.

Examples:

```bash
acpx codebuddy sessions new
acpx codebuddy 'review this branch'
acpx codebuddy exec 'summarize this repository'
```

If the executable is not named `codebuddy` on `PATH`, override the built-in in `~/.acpx/config.json`:

```json
{
  "agents": {
    "codebuddy": {
      "argv": ["/absolute/path/to/codebuddy", "--acp"]
    }
  }
}
```
