import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { acpTaskService, AcpTaskApiError } from './api';
import type { AcpRoleVersion, AcpRoleVersions } from './types';
import { date, text } from './ui';

const statusText = (status: AcpRoleVersion['status']) =>
    ({ proposed: text('候选', 'Proposed'), published: text('已上线', 'Published'), superseded: text('已替换', 'Superseded') })[status];

const failureText = (item: string) =>
    ({
        'features-unconfirmed': text('功能清单还没确认', 'Feature list not confirmed'),
        'project-unavailable': text('本机没有这个项目', 'No local clone'),
        'run-error': text('运行出错', 'Run error'),
    })[item] || item;

/** What a person checks before a version goes live: the changes, the diff and re-verification. Publishing happens only here. */
function ReleaseGate({ version, onPublished }: { version: AcpRoleVersion; onPublished: () => void }) {
    const [diff, setDiff] = useState<string | undefined>();
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const results = version.evaluation?.results ?? [];
    const changed = [...version.changes.added, ...version.changes.modified, ...version.changes.removed];
    const publish = async () => {
        setBusy(true);
        setError('');
        try {
            await acpTaskService.publishRoleVersion(version.roleId, version.version, note.trim() ? { note: note.trim() } : {});
            onPublished();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <article class="acp-process-request">
            <h4>
                {version.version}{' '}
                <span class={`acp-status acp-status-${version.status === 'proposed' ? 'pending' : version.status === 'published' ? 'completed' : 'canceled'}`}>{statusText(version.status)}</span>{' '}
                {version.parent && text(`父版本 ${version.parent}`, `parent ${version.parent}`)}
            </h4>
            <p>{version.proposal.summary}</p>
            <p class="acp-muted">{text('提出时间', 'Proposed')} {date(version.proposal.proposedAt)}</p>
            {version.checklistChanged && <p class="acp-notice">{text('这个版本改了检查单，请先看下面的改动。', 'This version changes the checklist; read the diff first.')}</p>}
            <h4>{text('改动的文件', 'Changed files')}</h4>
            {changed.length ? (
                <ul>
                    {version.changes.added.map(file => <li key={file}>{text('新增', 'Added')} {file}</li>)}
                    {version.changes.modified.map(file => <li key={file}>{text('修改', 'Modified')} {file}</li>)}
                    {version.changes.removed.map(file => <li key={file}>{text('删除', 'Removed')} {file}</li>)}
                </ul>
            ) : (
                <p class="acp-muted">{text('第一个版本，没有可比对的上线版本。', 'First version; nothing live to compare with.')}</p>
            )}
            {version.parent && (
                <Fragment>
                    {diff === undefined ? (
                        <button
                            type="button"
                            class="acp-button"
                            onClick={() => void acpTaskService.roleVersionDiff(version.roleId, version.version).then(value => setDiff(value.diff), err => setError(String(err)))}
                        >
                            {text('查看改动', 'Show diff')}
                        </button>
                    ) : (
                        <pre class="acp-tool-detail">{diff || text('没有文本差异', 'No text differences')}</pre>
                    )}
                </Fragment>
            )}
            <h4>{text('复验结果', 'Re-verification')}</h4>
            {results.length ? (
                <table>
                    <thead>
                        <tr>
                            <th>{text('用例', 'Case')}</th>
                            <th>{text('类型', 'Kind')}</th>
                            <th>{text('结果', 'Result')}</th>
                            <th>{text('轮次', 'Rounds')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {results.map(result => (
                            <tr key={result.caseId}>
                                <td>{result.caseId}</td>
                                <td>{result.kind === 'original' ? text('原题', 'Original') : text('变体', 'Variant')}</td>
                                <td>{result.passed ? text('通过', 'Passed') : `${text('未通过', 'Failed')}：${result.failedItems.map(failureText).join('、')}`}</td>
                                <td>{result.rounds}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <p class="acp-muted">{text('还没有复验结果，暂时不能上线。由教练运行 rsi eval。', 'No re-verification yet; it cannot go live. The coach runs rsi eval.')}</p>
            )}
            {version.status === 'proposed' && (
                <Fragment>
                    {error && <p class="acp-muted">{error}</p>}
                    <textarea
                        class="acp-reject-note"
                        maxLength={4000}
                        placeholder={text('上线说明（可选）', 'Release note (optional)')}
                        value={note}
                        onInput={event => setNote(event.currentTarget.value)}
                    />
                    <div class="acp-agent-actions">
                        <button type="button" class="acp-button acp-primary" disabled={busy || !results.length} onClick={() => void publish()}>
                            {text(`上线 ${version.version}`, `Publish ${version.version}`)}
                        </button>
                    </div>
                </Fragment>
            )}
            {version.decision && (
                <p class="acp-muted">
                    {text('上线人', 'Published by')} {version.decision.displayName || version.decision.by} · {date(version.decision.at)}
                    {version.decision.note && ` · ${version.decision.note}`}
                </p>
            )}
        </article>
    );
}

/** Role versions kept by the gateway. Hidden when the gateway has no rsi configuration. */
export function RoleVersions({ refreshKey }: { refreshKey: number }) {
    const [data, setData] = useState<AcpRoleVersions | undefined>();
    const [error, setError] = useState('');
    const [reload, setReload] = useState(0);
    useEffect(() => {
        let disposed = false;
        acpTaskService.listRoleVersions().then(
            value => { if (!disposed) { setData(value); setError(''); } },
            err => { if (!disposed) { setData(undefined); setError(err instanceof AcpTaskApiError && err.status === 404 ? '' : String(err)); } }
        );
        return () => { disposed = true; };
    }, [refreshKey, reload]);
    if (!data && !error) return null;
    return (
        <section class="acp-detail-section">
            <h3>{text('角色版本与上线门', 'Role versions and release gate')}</h3>
            {error && <p class="acp-muted">{error}</p>}
            {data?.roles.map(role => (
                <div key={role.roleId}>
                    <h4>
                        {role.roleId} · {text('已上线', 'Live')} {role.published ?? text('无', 'none')}
                    </h4>
                    {role.versions.map(version => (
                        <ReleaseGate key={version.version} version={version} onPublished={() => setReload(value => value + 1)} />
                    ))}
                    {!role.versions.length && <p class="acp-muted">{text('还没有版本。教练用 rsi propose 提出第一个版本。', 'No versions yet. The coach proposes one with rsi propose.')}</p>}
                </div>
            ))}
        </section>
    );
}
