import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PreparedTerminalShell {
  args: string[];
  env: Record<string, string>;
  integrationExpected: boolean;
  dispose(): void;
}

export function prepareTerminalShell(
  shell: string,
  env: Record<string, string>,
): PreparedTerminalShell {
  try {
    const executable = path.basename(shell).toLowerCase();
    if (executable === 'bash' || executable === 'bash.exe') return prepareBash(env);
    if (executable === 'zsh' || executable === 'zsh.exe') return prepareZsh(env);
    if (
      executable === 'pwsh' ||
      executable === 'pwsh.exe' ||
      executable === 'powershell' ||
      executable === 'powershell.exe'
    ) {
      return preparePowerShell(env);
    }
  } catch {
    // Shell integration is an optional enhancement; terminal startup must remain fail-open.
  }
  return { args: [], env, integrationExpected: false, dispose() {} };
}

function prepareBash(env: Record<string, string>): PreparedTerminalShell {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-terminal-bash-'));
  try {
    const rcFile = path.join(directory, 'bashrc');
    const homeRc = env.HOME ? path.join(env.HOME, '.bashrc') : '';
    const sourceLine = homeRc
      ? `if [ -f ${shellQuote(homeRc)} ]; then . ${shellQuote(homeRc)}; fi\n`
      : '';
    fs.writeFileSync(
      rcFile,
      `${sourceLine}PS0=$'\\e]633;C\\a'\${PS0-}\n__noveltea_prompt_command() {\n  local __noveltea_status=$?\n  printf '\\033]633;D;%s\\007' "$__noveltea_status"\n  printf '\\033]7;file://%s%s\\007' "\${HOSTNAME-}" "$PWD"\n  printf '\\033]633;A\\007'\n  return "$__noveltea_status"\n}\nif declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then\n  PROMPT_COMMAND=(__noveltea_prompt_command "\${PROMPT_COMMAND[@]}")\nelse\n  PROMPT_COMMAND="__noveltea_prompt_command\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"\nfi\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return disposablePreparedShell(['--rcfile', rcFile, '-i'], env, directory);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function prepareZsh(env: Record<string, string>): PreparedTerminalShell {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-terminal-zsh-'));
  try {
    const rcFile = path.join(directory, '.zshrc');
    const originalZdotdir = env.ZDOTDIR ?? env.HOME ?? '';
    const originalRc = originalZdotdir ? path.join(originalZdotdir, '.zshrc') : '';
    const sourceLine = originalRc
      ? `if [[ -f ${shellQuote(originalRc)} ]]; then source ${shellQuote(originalRc)}; fi\n`
      : '';
    fs.writeFileSync(
      rcFile,
      `${sourceLine}autoload -Uz add-zsh-hook\n__noveltea_preexec() { print -n -- $'\\e]633;C\\a' }\n__noveltea_precmd() {\n  local __noveltea_status=$?\n  print -n -- $'\\e]633;D;'"$__noveltea_status"$'\\a'\n  print -n -- $'\\e]7;file://'"\${HOST-}""$PWD"$'\\a'\n  print -n -- $'\\e]633;A\\a'\n}\nadd-zsh-hook preexec __noveltea_preexec\nadd-zsh-hook precmd __noveltea_precmd\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return disposablePreparedShell(['-i'], { ...env, ZDOTDIR: directory }, directory);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function preparePowerShell(env: Record<string, string>): PreparedTerminalShell {
  const script = [
    '$global:__novelteaRunning = $false',
    '$global:__novelteaLifecycleEnabled = $false',
    'try {',
    '  Import-Module PSReadLine -ErrorAction Stop',
    '  $global:__novelteaPreviousHistoryHandler = (Get-PSReadLineOption).AddToHistoryHandler',
    '  Set-PSReadLineOption -AddToHistoryHandler {',
    '    param($line)',
    '    [Console]::Write("`e]633;C`a")',
    '    $global:__novelteaRunning = $true',
    '    if ($null -ne $global:__novelteaPreviousHistoryHandler) {',
    '      return [bool](& $global:__novelteaPreviousHistoryHandler $line)',
    '    }',
    '    return $true',
    '  }',
    '  $global:__novelteaLifecycleEnabled = $true',
    '} catch {}',
    '$global:__novelteaPreviousPrompt = $function:prompt',
    'function global:prompt {',
    '  $status = $?',
    '  if ($global:__novelteaLifecycleEnabled -and $global:__novelteaRunning) {',
    '    $code = if ($status) { 0 } else { 1 }',
    '    [Console]::Write("`e]633;D;$code`a")',
    '    $global:__novelteaRunning = $false',
    '  }',
    '  try { [Console]::Write("`e]7;" + ([System.Uri]::new($pwd.ProviderPath).AbsoluteUri) + "`a") } catch {}',
    '  if ($global:__novelteaLifecycleEnabled) { [Console]::Write("`e]633;A`a") }',
    '  if ($null -ne $global:__novelteaPreviousPrompt) { return & $global:__novelteaPreviousPrompt }',
    '  return "PS $($executionContext.SessionState.Path.CurrentLocation)> "',
    '}',
  ].join('\n');
  return {
    args: ['-NoExit', '-Command', script],
    env,
    integrationExpected: true,
    dispose() {},
  };
}

function disposablePreparedShell(
  args: string[],
  env: Record<string, string>,
  directory: string,
): PreparedTerminalShell {
  return {
    args,
    env,
    integrationExpected: true,
    dispose() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
