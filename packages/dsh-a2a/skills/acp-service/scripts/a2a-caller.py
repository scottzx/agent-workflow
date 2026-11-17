#!/usr/bin/env python3
"""Bounded, notification-driven A2A caller. No polling or child-session log reader."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    os.replace(temporary, path)


def transcript(run):
    # Only this root's native records; never open a worker session or print reasoning.
    with Path(run['rootTranscript']).open() as stream:
        for line in stream:
            # Image/tool outputs can be huge; they are not calls, user notices or turn boundaries.
            header = line[:320]
            if any('"' + kind + '"' in header for kind in ['custom_tool_call_output', 'function_call_output', 'reasoning']):
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def calls(run):
    output, seen = [], set()
    for row in transcript(run):
        item = row.get('payload', {})
        if row.get('type') == 'response_item' and item.get('type') in ['function_call', 'custom_tool_call']:
            key = item.get('call_id')
            if key and key not in seen:
                seen.add(key)
                output.append({'callId': key, 'name': item.get('name'), 'timestamp': row.get('timestamp')})
    return output


def action(run, name):
    current = calls(run)[-1]
    run.setdefault('actionCalls', {})[name] = current['callId']
    return current


def rpc(run, method, params):
    request = urllib.request.Request(run['gatewayUrl'].rstrip('/') + '/invoke',
        data=json.dumps({'method': method, 'params': params}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def actual_notice(run, notice_id):
    entered = False
    for row in transcript(run):
        item = row.get('payload', {})
        if item.get('call_id') == run['actionCalls']['dispatch']:
            entered = True
        if not entered or row.get('type') != 'response_item' or item.get('type') != 'message' or item.get('role') != 'user':
            continue
        text = ''.join(c.get('text', '') for c in item.get('content', []) if isinstance(c, dict))
        for candidate in re.findall(r'\{[^{}]*"noticeId"\s*:[^{}]*\}', text):
            try:
                notice = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            receipt = run['dispatchReceipt']
            if notice.get('noticeId') == notice_id and notice.get('originSessionId') == run['originSessionId']:
                matches = (notice.get('jobId') == receipt['jobId'] if 'jobId' in notice
                           else notice.get('taskId') == receipt.get('taskId') and notice.get('remote') == receipt.get('remote'))
                if matches:
                    return {**notice, 'receivedAt': row.get('timestamp')}
    raise ValueError('No matching real user notification in the root transcript; querying before wake is prohibited')


def dispatch(path, run, invoke=rpc):
    if run['phase'] != 'prepared' or not run.get('developmentReady'):
        raise ValueError('Dispatch requires finished development/deployment and a prepared run; never automatically resend')
    if not run['request'].get('clientRequestId'):
        raise ValueError('A stable clientRequestId is required')
    run['dispatchBoundary'] = action(run, 'dispatch')
    run['phase'] = 'admission_inflight'
    save(path, run)  # Crash after sending never creates permission to resend.
    try:
        receipt = invoke(run, 'execution_submit', {'originSessionId': run['originSessionId'], **run['request']})
        if receipt.get('error') or receipt.get('submissionStatus') != 'accepted':
            run['phase'] = 'admission_requires_attention'
        else:
            run['phase'] = 'waiting_notification'
        run['dispatchReceipt'] = receipt
    except Exception as error:
        run['phase'] = 'admission_unknown'
        run['admissionError'] = str(error)
    save(path, run)
    summary = {k: v for k, v in run.get('dispatchReceipt', {}).items() if k in
               ['jobId', 'attemptId', 'remote', 'taskId', 'contextId', 'sessionId', 'submissionStatus', 'executionStatus', 'error']}
    return {'phase': run['phase'], 'receipt': summary, 'error': run.get('admissionError'),
            'mustEndTurn': True, 'nextAction': 'End this turn now. Handle only a real arriving notice.',
            'prohibited': ['task polling', 'sleep/wait for completion', 'worker session logs', 'repeat artifact QA', 'post-dispatch development']}


def inspect(path, run, notice_id, invoke=rpc):
    if run['phase'] != 'waiting_notification':
        raise ValueError('Inspect is a one-shot operation after a notification, not a polling command')
    notice = actual_notice(run, notice_id)
    action(run, 'inspect')
    run['notice'] = notice
    run['phase'] = 'inspection_inflight'
    save(path, run)
    errors, report, receipt = [], None, None
    try:
        receipt = invoke(run, 'execution_get', {'originSessionId': run['originSessionId'], 'jobId': run['dispatchReceipt']['jobId']})
        if receipt['attemptId'] != run['dispatchReceipt']['attemptId'] or receipt.get('taskId') != run['dispatchReceipt'].get('taskId'):
            raise ValueError('Receipt execution identity changed')
        metadata = receipt.get('resultMetadata') or {}
        if receipt['executionStatus'] != 'completed' or metadata.get('producer') != '1agents/a2a-host' or metadata.get('outcome') != 'completed':
            raise ValueError('Worker did not deliver a completed host-authored result')
        if metadata.get('taskId') != receipt['taskId'] or metadata.get('validation', {}).get('status') != 'passed':
            raise ValueError('Host result validation or task binding failed')
        if metadata.get('sessionId') == run['review'].get('producerSessionId'):
            raise ValueError('Reviewer must be independent of the PPT producer')
        if receipt.get('sessionId') and metadata.get('sessionId') != receipt['sessionId']:
            raise ValueError('Host result session differs from the execution receipt')
        if run['review'].get('expectedPreset') and metadata.get('agentPreset') != run['review']['expectedPreset']:
            raise ValueError('Reviewer preset differs from the frozen target')
        # Read only the NEW report, bound to the host receipt. Never reopen PPTs/PNGs or download them here.
        target = Path(run['review']['reportPath']).resolve()
        artifact = next(a for a in metadata.get('artifacts', []) if Path(a['path']).resolve() == target)
        raw = target.read_bytes()
        if hashlib.sha256(raw).hexdigest() != artifact['sha256'] or len(raw) != artifact['size']:
            raise ValueError('Review report differs from the host receipt')
        report = json.loads(raw)
        if report.get('artifactDigest') != run['review']['artifactDigest']:
            raise ValueError('Report is bound to a different PPT version')
        if report.get('verdict') not in ['passed', 'changes_requested'] or not isinstance(report.get('issues'), list):
            raise ValueError('Invalid report verdict or issues')
        if report['verdict'] == 'passed' and (report['issues'] or report.get('factsChecked') is not True or report.get('allSlidesViewed') is not True):
            raise ValueError('Passed report lacks required independent checks')
    except Exception as error:
        errors.append(str(error))
    run['inspection'] = {'receipt': receipt, 'report': report, 'errors': errors, 'valid': not errors}
    run['phase'] = 'inspected'
    save(path, run)
    return {'phase': run['phase'], 'valid': not errors, 'report': report, 'errors': errors,
            'existingArtifacts': run['review'].get('links', []), 'nextAction': 'Record the conclusion once; do not repeat worker QA or dispatch fixes.'}


def record(path, run):
    if run['phase'] != 'inspected':
        raise ValueError('Record requires the one-shot receipt inspection')
    action(run, 'record')
    report = run['inspection'].get('report') or {}
    run['conclusion'] = {'recordedAt': now(), 'jobId': run['dispatchReceipt']['jobId'],
        'attemptId': run['dispatchReceipt']['attemptId'], 'noticeId': run['notice']['noticeId'],
        'reportValid': run['inspection']['valid'], 'verdict': report.get('verdict', 'unverified'),
        'issues': report.get('issues', []), 'errors': run['inspection']['errors'],
        'decision': 'Preserve the existing PPT and report; no edits or follow-up production authorized',
        'pptBusinessAccepted': False, 'executionReviewRecorded': False}
    save(Path(path).with_name('processing-conclusion.json'), run['conclusion'])
    run['phase'] = 'conclusion_recorded'
    save(path, run)
    return run['conclusion']


def audit(run):
    native = calls(run)
    start = next(i for i, c in enumerate(native) if c['callId'] == run['actionCalls']['dispatch'])
    stop = next(i for i, c in enumerate(native) if c['callId'] == run['actionCalls']['ack'])
    measured = native[start:stop + 1]
    notice = actual_notice(run, run['notice']['noticeId'])
    before_wake = [c for c in measured[1:] if c['timestamp'] < notice['receivedAt']]
    unexpected = [c for c in measured if c['callId'] not in run['actionCalls'].values()]
    yielded = False
    for row in transcript(run):
        if not (run['dispatchBoundary']['timestamp'] <= row.get('timestamp', '') < notice['receivedAt']):
            continue
        item = row.get('payload', {})
        if row.get('type') == 'response_item' and item.get('role') == 'assistant' and (item.get('phase') == 'final_answer' or item.get('channel') == 'final'):
            yielded = True
        if row.get('type') == 'event_msg' and item.get('type') in ['task_complete', 'task_completed', 'turn_complete', 'turn_completed']:
            yielded = True
    return {'countingRule': 'Every unique native root tool call from dispatch through this ack inclusive; development before dispatch and worker calls excluded; no reset.',
        'rootToolCalls': len(measured), 'calls': measured, 'actionCalls': run['actionCalls'],
        'callsBeforeNotification': before_wake, 'unexpectedCalls': unexpected,
        'nativeNotificationReceived': True, 'rootTurnEndedBeforeNotification': yielded,
        'stepBudgetMet': 3 <= len(measured) <= 5,
        'strictAsyncFlowPassed': 3 <= len(measured) <= 5 and not before_wake and not unexpected and yielded,
        'qualityVerdict': run['conclusion']['verdict'], 'pptChanged': False}


def acknowledge(path, run, invoke=rpc):
    if run['phase'] != 'conclusion_recorded':
        raise ValueError('Save a conclusion before acknowledging')
    action(run, 'ack')
    method = 'execution_ack' if 'jobId' in run['notice'] else 'remote_agent_ack'
    run['ack'] = invoke(run, method, {'originSessionId': run['originSessionId'], 'noticeId': run['notice']['noticeId']})
    run['phase'] = 'acknowledged'
    run['measurement'] = audit(run)
    save(path, run)
    save(Path(path).with_name('step-count.json'), run['measurement'])
    return {'phase': run['phase'], 'ack': run['ack'], 'measurement': run['measurement'],
            'existingArtifacts': run['review'].get('links', []), 'nextAction': 'Final answer now; no extra query or audit call.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['dispatch', 'inspect', 'record', 'ack'])
    parser.add_argument('--run', required=True)
    parser.add_argument('--notice-id')
    args = parser.parse_args()
    path = Path(args.run)
    lock = path.with_name(path.name + '.lock')
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        run = json.loads(path.read_text())
        if args.action == 'dispatch': result = dispatch(path, run)
        elif args.action == 'inspect': result = inspect(path, run, args.notice_id)
        elif args.action == 'record': result = record(path, run)
        else: result = acknowledge(path, run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        os.close(fd)
        lock.unlink()


if __name__ == '__main__':
    main()
