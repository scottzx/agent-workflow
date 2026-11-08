import { useEffect, useState } from 'preact/hooks';
import { acpTaskService, AcpTaskApiError } from './api';
import type { AcpAgentCatalog, AcpAgentOption, AcpAgentRow, AcpTaskSummary } from './types';
import { EmptyState, ErrorState, text } from './ui';

const emptyCatalog: AcpAgentCatalog = { developing: [], published: [] };

function agentError(error: unknown): string {
    if (error instanceof AcpTaskApiError) {
        if (error.code === 'conflict') return text('这个名字已经在用', 'That name is already in use');
        if (error.code === 'not_found') return text('找不到这份开发草稿', 'Draft not found');
        if (error.code === 'invalid') return text('设置格式不正确。选项写成 id=value，模型项可以写成 model:id=value', 'Settings are not valid. Write options as id=value');
    }
    return error instanceof Error ? error.message : String(error);
}

function channelLabel(channel?: string): string {
    if (channel === 'trial') return text('试跑', 'Trial');
    if (channel === 'formal') return text('正式', 'Formal');
    return text('临时', 'Temporary');
}

function optionLines(options: AcpAgentOption[]): string {
    return options.map(option => `${option.model && option.id !== 'model' ? 'model:' : ''}${option.id}=${option.value}`).join('\n');
}

function parseOptions(raw: string): AcpAgentOption[] {
    return raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            let model = false;
            let body = line;
            if (body.startsWith('model:')) {
                model = true;
                body = body.slice('model:'.length);
            }
            const eq = body.indexOf('=');
            const id = eq > 0 ? body.slice(0, eq).trim() : '';
            const value = eq > 0 ? body.slice(eq + 1).trim() : '';
            if (!id || !value) throw new Error(text('每一行写成 id=value', 'Write each option as id=value'));
            if (id === 'model') model = true;
            return { id, value, ...(model ? { model: true as const } : {}) };
        });
}

function rowsOf(catalog: AcpAgentCatalog, phase: 'developing' | 'published'): AcpAgentRow[] {
    return phase === 'developing' ? catalog.developing : catalog.published;
}

/** Developing drafts and published names. A passed review does not publish a draft. */
export function AgentModule({ refreshKey, onOpenTask }: { refreshKey: number; onOpenTask: (jobId: string) => void }) {
    const [reload, setReload] = useState(0);
    const [phase, setPhase] = useState<'developing' | 'published'>('developing');
    const [catalog, setCatalog] = useState<AcpAgentCatalog>(emptyCatalog);
    const [tasks, setTasks] = useState<AcpTaskSummary[]>([]);
    const [selectedId, setSelectedId] = useState('');
    const [creating, setCreating] = useState(false);
    const [registering, setRegistering] = useState(false);
    const [agentPath, setAgentPath] = useState('');
    const [pathAgent, setPathAgent] = useState('grok-build');
    const [pathRuntime, setPathRuntime] = useState<'acp' | 'native'>('acp');
    const [pathPreset, setPathPreset] = useState('standard');
    const [pathModel, setPathModel] = useState('');
    const [connectionId, setConnectionId] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState('');
    const [acpAgent, setAcpAgent] = useState('grok-build');
    const [roleId, setRoleId] = useState('');
    const [targetId, setTargetId] = useState('');
    const [modeId, setModeId] = useState('');
    const [optionText, setOptionText] = useState('');
    const [releaseName, setReleaseName] = useState('');
    const [replace, setReplace] = useState(false);

    useEffect(() => {
        let disposed = false;
        setLoading(true);
        void (async () => {
            try {
                const [nextCatalog, nextTasks] = await Promise.all([
                    acpTaskService.listAgents(),
                    acpTaskService.list('all', 0, 100),
                ]);
                if (disposed) return;
                setCatalog(nextCatalog);
                setTasks(nextTasks.items);
                setError('');
            } catch (err) {
                if (!disposed) setError(agentError(err));
            } finally {
                if (!disposed) setLoading(false);
            }
        })();
        return () => {
            disposed = true;
        };
    }, [refreshKey, reload]);

    const rows = rowsOf(catalog, phase);
    const connections = catalog.connections ?? [];
    const chosenConnection = connectionId || connections[0]?.connectionId || '';
    const selected = [...catalog.developing, ...catalog.published].find(row => row.agentId === selectedId);
    const stamp = selected
        ? [selected.agentId, selected.modeId, selected.targetId, selected.roleId, selected.acpAgent, optionLines(selected.options)].join('|')
        : '';
    useEffect(() => {
        if (!selected) return;
        setName(selected.name);
        setAcpAgent(selected.acpAgent || '');
        setRoleId(selected.roleId || '');
        setTargetId(selected.targetId || '');
        setModeId(selected.modeId || '');
        setOptionText(optionLines(selected.options));
        setReleaseName(selected.releaseName || selected.name);
        setReplace(false);
    }, [stamp]);

    const draftInput = () => ({
        name: name.trim(),
        acpAgent: acpAgent.trim(),
        ...(roleId.trim() ? { roleId: roleId.trim() } : {}),
        ...(targetId.trim() ? { targetId: targetId.trim() } : {}),
        ...(modeId.trim() ? { modeId: modeId.trim() } : {}),
        ...(optionText.trim() ? { options: parseOptions(optionText) } : {}),
    });
    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setNotice('');
        setError('');
        try {
            await work();
        } catch (err) {
            setError(agentError(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div class="acp-agent-module">
            <p class="acp-agent-note">
                {text(
                    '发布冻结的是工作台里的一行名字。执行宿主仍按该工作区和 ACP Agent 最近一次已接受的 ACP 设置回放，发布结果写进宿主缓存还没接上。审核通过不会上线。',
                    'Publishing freezes a workbench name. The execution host still replays the last accepted ACP settings for that workspace and ACP agent. Syncing a release into the host cache is not connected. Approving a review does not publish.'
                )}
            </p>
            <nav class="acp-workbench-views" aria-label={text('智能体阶段', 'Agent phase')}>
                <button type="button" aria-pressed={phase === 'developing'} onClick={() => setPhase('developing')}>
                    {text('开发中', 'In development')}
                    <span>{catalog.developing.length}</span>
                </button>
                <button type="button" aria-pressed={phase === 'published'} onClick={() => setPhase('published')}>
                    {text('已上线', 'Published')}
                    <span>{catalog.published.length}</span>
                </button>
            </nav>
            {error && <ErrorState title={text('智能体读取或保存失败', 'Could not load or save agents')} message={error} onRetry={() => setReload(value => value + 1)} />}
            {loading && <p class="acp-muted">{text('正在载入…', 'Loading…')}</p>}
            {!loading && !error && !rows.length && !creating && !registering && (
                <EmptyState
                    title={phase === 'developing' ? text('还没有开发中的智能体', 'No agents in development') : text('还没有已上线的名字', 'No published names')}
                    description={text('常驻角色会直接出现在已上线。新的试跑从开发中的草稿开始。', 'Resident roles appear under Published. A new trial starts from a developing draft.')}
                />
            )}
            <div class="acp-agent-layout">
                <div class="acp-agent-list">
                    {phase === 'developing' && (
                        <>
                            <button type="button" class="acp-button" onClick={() => { setCreating(true); setRegistering(false); setSelectedId(''); setName(''); setAcpAgent('grok-build'); setRoleId(''); setTargetId(''); setModeId(''); setOptionText(''); }}>
                                {text('新建草稿', 'New draft')}
                            </button>
                            <button type="button" class="acp-button" onClick={() => { setRegistering(true); setCreating(false); setSelectedId(''); }}>
                                {text('按路径登记', 'Register a path')}
                            </button>
                        </>
                    )}
                    {rows.map(row => (
                        <button
                            key={row.agentId}
                            type="button"
                            class={`acp-agent-row${selectedId === row.agentId ? ' is-selected' : ''}`}
                            onClick={() => { setSelectedId(row.agentId); setCreating(false); setRegistering(false); }}
                        >
                            <strong>{row.name}</strong>
                            <small>{row.acpAgent || row.agentPreset || row.origin}</small>
                            <small>
                                {text('任务', 'Tasks')} {row.taskCount} · {text('待确认', 'Waiting')} {row.pendingCount}
                            </small>
                        </button>
                    ))}
                </div>
                <div class="acp-agent-detail">
                    {registering && (
                        <form
                            class="acp-agent-form"
                            onSubmit={event => {
                                event.preventDefault();
                                void run(async () => {
                                    const model = pathModel.trim(), slash = model.indexOf('/');
                                    if (pathRuntime === 'native' && model && slash <= 0) throw new Error(text('模型写成 provider/model，例如 minimax-cn/MiniMax-M3.1-Flash', 'Write the model as provider/model'));
                                    const saved = await acpTaskService.registerAgentPath({
                                        path: agentPath.trim(),
                                        connectionId: chosenConnection,
                                        ...(pathRuntime === 'acp'
                                            ? { acpAgent: pathAgent.trim() }
                                            : { agentPreset: pathPreset.trim(), ...(model ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : {}) }),
                                    });
                                    setCatalog(saved);
                                    setRegistering(false);
                                    setPhase('developing');
                                    setSelectedId(saved.registered[0]?.agentId ?? '');
                                    setNotice(text(
                                        `已登记 ${saved.registered.map(item => item.name).join('、')}。每个都有自己的执行目标，派发时宿主读取 agent 文件作为角色说明。`,
                                        `Registered ${saved.registered.map(item => item.name).join(', ')}. Each has its own target; the host reads the agent file as its role at dispatch.`,
                                    ));
                                });
                            }}
                        >
                            <h3>{text('按路径登记', 'Register a path')}</h3>
                            <p class="acp-muted">
                                {text(
                                    '读取这个目录下的 agents/*.md，每个文件登记成一个开发中的智能体，名字是“文件名@运行方式”，工作目录就是这个目录。同一个目录可以分别登记 grok、DSH 原生等多种运行方式；同一种运行方式再登记一次会更新原有记录。',
                                    'Each agents/*.md under the directory becomes a developing agent named name@runtime that runs in that directory. One directory can be registered on several runtimes; registering the same runtime again updates its records.'
                                )}
                            </p>
                            <label>
                                {text('目录路径', 'Directory')}
                                <input value={agentPath} placeholder="/absolute/path/to/scenario" onInput={event => setAgentPath(event.currentTarget.value)} />
                            </label>
                            <label>
                                {text('运行方式', 'Runtime')}
                                <select value={pathRuntime} onChange={event => setPathRuntime(event.currentTarget.value === 'native' ? 'native' : 'acp')}>
                                    <option value="acp">{text('ACP Agent', 'ACP agent')}</option>
                                    <option value="native">{text('DSH 原生预设', 'DSH-native preset')}</option>
                                </select>
                            </label>
                            {pathRuntime === 'acp' ? (
                                <label>
                                    ACP Agent
                                    <input value={pathAgent} placeholder="grok-build" onInput={event => setPathAgent(event.currentTarget.value)} />
                                </label>
                            ) : (
                                <>
                                    <label>
                                        {text('预设', 'Preset')}
                                        <input value={pathPreset} placeholder="standard" onInput={event => setPathPreset(event.currentTarget.value)} />
                                    </label>
                                    <label>
                                        {text('模型（可选）', 'Model (optional)')}
                                        <input value={pathModel} placeholder="minimax-cn/MiniMax-M3.1-Flash" onInput={event => setPathModel(event.currentTarget.value)} />
                                    </label>
                                </>
                            )}
                            <label>
                                {text('执行连接', 'Connection')}
                                <select value={chosenConnection} onChange={event => setConnectionId(event.currentTarget.value)}>
                                    {connections.map(item => (
                                        <option key={item.connectionId} value={item.connectionId}>{item.connectionId} · {item.remote}</option>
                                    ))}
                                </select>
                            </label>
                            <button type="submit" class="acp-button" disabled={busy || !agentPath.trim() || !chosenConnection || !(pathRuntime === 'acp' ? pathAgent.trim() : pathPreset.trim())}>
                                {text('登记', 'Register')}
                            </button>
                        </form>
                    )}
                    {creating && (
                        <form
                            class="acp-agent-form"
                            onSubmit={event => {
                                event.preventDefault();
                                void run(async () => {
                                    const saved = await acpTaskService.createAgent(draftInput());
                                    setCatalog(saved);
                                    setCreating(false);
                                    setSelectedId(saved.draft.agentId);
                                    setPhase('developing');
                                    setNotice(text('草稿已保存。派发仍不会读取这份草稿，要发布后新任务才挂到这个名字。', 'Draft saved. Dispatch does not read it until you publish, and new tasks then use that name.'));
                                });
                            }}
                        >
                            <h3>{text('新建开发草稿', 'New developing draft')}</h3>
                            <AgentFields
                                name={name}
                                acpAgent={acpAgent}
                                roleId={roleId}
                                targetId={targetId}
                                modeId={modeId}
                                optionText={optionText}
                                onName={setName}
                                onAgent={setAcpAgent}
                                onRole={setRoleId}
                                onTarget={setTargetId}
                                onMode={setModeId}
                                onOptions={setOptionText}
                            />
                            <button type="submit" class="acp-button" disabled={busy || !name.trim() || !acpAgent.trim()}>
                                {text('保存草稿', 'Save draft')}
                            </button>
                        </form>
                    )}
                    {selected && !creating && !registering && (
                        <>
                            <h3>{selected.name}</h3>
                            <p class="acp-muted">
                                {selected.origin === 'resident'
                                    ? text('这是已经在跑的常驻角色，不要求先补一次试跑。', 'This resident role is already running. It does not require a prior trial.')
                                    : selected.origin === 'release'
                                      ? text('这是已发布的名字。之后再改 ACP 设置，只改开发中的草稿。', 'This is a published name. Later ACP setting edits update the developing draft.')
                                      : text('这是开发草稿。试跑任务会挂在这里。审核通过不会自动上线。', 'This is a developing draft. Trial tasks attach here. A passed review does not publish it.')}
                            </p>
                            {selected.counterpartId && (
                                <button type="button" class="acp-link" onClick={() => {
                                    const other = [...catalog.developing, ...catalog.published].find(row => row.agentId === selected.counterpartId);
                                    if (!other) return;
                                    setPhase(other.phase);
                                    setSelectedId(other.agentId);
                                }}>
                                    {selected.phase === 'developing' ? text('查看已上线的名字', 'Open the published name') : text('查看开发中的草稿', 'Open the developing draft')}
                                </button>
                            )}
                            <dl class="acp-agent-facts">
                                <div><dt>ACP Agent</dt><dd>{selected.acpAgent || '—'}</dd></div>
                                {selected.origin !== 'resident' && selected.agentPreset && <div><dt>{text('预设', 'Preset')}</dt><dd>{selected.agentPreset}</dd></div>}
                                {selected.provider && <div><dt>{text('模型', 'Model')}</dt><dd>{selected.provider}/{selected.model}</dd></div>}
                                <div><dt>{text('模式', 'Mode')}</dt><dd>{selected.modeId || '—'}</dd></div>
                                <div><dt>{text('执行目标', 'Target')}</dt><dd>{selected.targetId || '—'}</dd></div>
                                <div><dt>{text('角色', 'Role')}</dt><dd>{selected.roleId || '—'}</dd></div>
                                {selected.source && <div><dt>{text('来源', 'Source')}</dt><dd>{selected.source.file}</dd></div>}
                            </dl>
                            {selected.description && <p>{selected.description}</p>}
                            {selected.options.length > 0 && (
                                <ul>
                                    {selected.options.map(option => (
                                        <li key={option.id}>{option.id}={option.value}</li>
                                    ))}
                                </ul>
                            )}
                            <h4>{text('名下任务', 'Tasks')}</h4>
                            {tasks.filter(task => task.agentId === selected.agentId).length === 0 && (
                                <p class="acp-muted">{text('还没有挂到这条记录上的任务。', 'No tasks are attached to this record yet.')}</p>
                            )}
                            <ul>
                                {tasks.filter(task => task.agentId === selected.agentId).map(task => (
                                    <li key={task.jobId}>
                                        <button type="button" class="acp-link" onClick={() => onOpenTask(task.jobId)}>
                                            {channelLabel(task.channel)} · {task.title || task.jobId}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                            {selected.origin === 'draft' && (
                                <form
                                    class="acp-agent-form"
                                    onSubmit={event => {
                                        event.preventDefault();
                                        void run(async () => {
                                            const saved = await acpTaskService.updateAgent(selected.agentId, draftInput());
                                            setCatalog(saved);
                                            setNotice(text('草稿已更新。正在跑的发布名字没有变。', 'Draft updated. The published name stays as it was.'));
                                        });
                                    }}
                                >
                                    <h4>{text('修改草稿', 'Edit draft')}</h4>
                                    <AgentFields
                                        name={name}
                                        acpAgent={acpAgent}
                                        roleId={roleId}
                                        targetId={targetId}
                                        modeId={modeId}
                                        optionText={optionText}
                                        onName={setName}
                                        onAgent={setAcpAgent}
                                        onRole={setRoleId}
                                        onTarget={setTargetId}
                                        onMode={setModeId}
                                        onOptions={setOptionText}
                                    />
                                    <small>{text('选项留空表示不修改。模型项写 model=值，或 model:选项id=值。', 'Leave options blank to keep them. Write a model as model=value, or model:id=value.')}</small>
                                    <button type="submit" class="acp-button" disabled={busy}>{text('保存修改', 'Save changes')}</button>
                                </form>
                            )}
                            {selected.origin === 'draft' && (
                                <form
                                    class="acp-agent-form"
                                    onSubmit={event => {
                                        event.preventDefault();
                                        void run(async () => {
                                            const saved = await acpTaskService.publishAgent(selected.agentId, {
                                                releaseName: releaseName.trim(),
                                                ...(replace ? { replace: true } : {}),
                                            });
                                            setCatalog(saved);
                                            setPhase('published');
                                            setSelectedId(`release:${releaseName.trim()}`);
                                            setNotice(text('名字已发布。新的正式任务会挂到这个名字。宿主回放仍用该工作区最近一次 ACP 设置。', 'Name published. New formal tasks use it. Host replay still uses the latest ACP settings for that workspace.'));
                                        });
                                    }}
                                >
                                    <h4>{text('发布一行名字', 'Publish a name')}</h4>
                                    <label>
                                        {text('名字', 'Name')}
                                        <input value={releaseName} onInput={event => setReleaseName(event.currentTarget.value)} />
                                    </label>
                                    <label>
                                        <input type="checkbox" checked={replace} onChange={event => setReplace(event.currentTarget.checked)} />
                                        {text('覆盖同名的已发布记录', 'Replace the published record with this name')}
                                    </label>
                                    <button type="submit" class="acp-button" disabled={busy || !releaseName.trim()}>{text('发布', 'Publish')}</button>
                                </form>
                            )}
                            {notice && <p>{notice}</p>}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function AgentFields(props: {
    name: string;
    acpAgent: string;
    roleId: string;
    targetId: string;
    modeId: string;
    optionText: string;
    onName: (value: string) => void;
    onAgent: (value: string) => void;
    onRole: (value: string) => void;
    onTarget: (value: string) => void;
    onMode: (value: string) => void;
    onOptions: (value: string) => void;
}) {
    return (
        <>
            <label>
                {text('名称', 'Name')}
                <input value={props.name} onInput={event => props.onName(event.currentTarget.value)} />
            </label>
            <label>
                ACP Agent
                <input value={props.acpAgent} placeholder="grok-build" onInput={event => props.onAgent(event.currentTarget.value)} />
            </label>
            <label>
                {text('角色 ID', 'Role ID')}
                <input value={props.roleId} onInput={event => props.onRole(event.currentTarget.value)} />
            </label>
            <label>
                {text('执行目标 ID', 'Target ID')}
                <input value={props.targetId} onInput={event => props.onTarget(event.currentTarget.value)} />
            </label>
            <label>
                modeId
                <input value={props.modeId} placeholder="mode id" onInput={event => props.onMode(event.currentTarget.value)} />
            </label>
            <label>
                {text('ACP 选项', 'ACP options')}
                <textarea
                    rows={4}
                    value={props.optionText}
                    placeholder={'model=grok-2\nreasoningEffort=high'}
                    onInput={event => props.onOptions(event.currentTarget.value)}
                />
            </label>
        </>
    );
}
