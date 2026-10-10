import { useEffect, useState } from 'react';
import { useLive, vigil } from '../api';
import { Button, Chip, SectionHead } from '../components/ui';
import { timeAgo } from '../format';
import { cleanError } from './onboarding/ApiKeys';
import './onboarding/onboarding.css';

/**
 * The telemetry relay card: the only place shipping is turned on. Off by
 * default and safe by default — with it off, nothing here runs and nothing
 * leaves the computer. Minimal on purpose: address, device id, token, toggle
 * and one status line.
 */

const STATUS_LINES: Record<string, string> = {
  off: 'Off',
  running: 'Shipping',
  backoff: 'Shipping — the relay is unreachable; retrying',
  gap: 'Shipping — there is a gap: some older events were pruned before they could ship',
  revoked: 'Stopped — the relay no longer accepts this device token',
  error: 'Stopped — something went wrong; will keep retrying',
};

export function RelaySection() {
  const [view, reload] = useLive(() => vigil.getRelay());
  const [endpointUrl, setEndpointUrl] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const head = (
    <SectionHead
      title="Telemetry relay"
      sub="Ship a redacted copy of what Vigil saw to the relay your security team runs, so it can review this computer's alerts even when the computer is elsewhere. Nothing leaves until shipping is turned on, and the SOC can only ever read."
    />
  );
  const disabled = !view?.canSave;
  // Seed the fields whenever the saved config arrives or changes. Hooks stay
  // above the early return so their order never changes.
  const savedEndpoint = view?.config.endpointUrl;
  const savedDeviceId = view?.config.deviceId;
  useEffect(() => {
    if (savedEndpoint !== undefined) setEndpointUrl(savedEndpoint);
    if (savedDeviceId !== undefined) setDeviceId(savedDeviceId);
  }, [savedEndpoint, savedDeviceId]);

  if (!view) return head;
  const dirty = endpointUrl !== view.config.endpointUrl || deviceId !== view.config.deviceId;

  const guard = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      setToken('');
      reload();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const saveFields = () =>
    guard(() =>
      vigil.setRelayConfig({
        endpointUrl: endpointUrl.trim().replace(/\/+$/, ''),
        deviceId: deviceId.trim(),
      }),
    );

  const setEnabled = (on: boolean) => guard(() => vigil.setRelayConfig({ enabled: on }));

  const status =
    view.status.state === 'running' || view.status.state === 'backoff'
      ? `${STATUS_LINES[view.status.state]} · ${view.status.lagRecords} event${view.status.lagRecords === 1 ? '' : 's'} behind`
      : STATUS_LINES[view.status.state];

  return (
    <>
      {head}
      <div className="col" style={{ gap: 10 }}>
        <div className="row spread">
          <span>Ship telemetry to the relay</span>
          <Segmented
            label="Telemetry shipping"
            value={view.config.enabled ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
            disabled={disabled || busy}
            onChange={(v) => void setEnabled(v === 'on')}
          />
        </div>
        <form
          className="row key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveFields();
          }}
        >
          <input
            className="input grow"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Relay address, e.g. https://relay.example.com"
            aria-label="Relay address"
            value={endpointUrl}
            disabled={disabled || busy}
            onChange={(e) => setEndpointUrl(e.target.value)}
          />
          <input
            className="input"
            style={{ width: 220 }}
            autoComplete="off"
            spellCheck={false}
            placeholder="Device id"
            aria-label="Device id"
            value={deviceId}
            disabled={disabled || busy}
            onChange={(e) => setDeviceId(e.target.value)}
          />
          <Button type="submit" kind="primary" size="sm" disabled={disabled || busy || !dirty}>
            Save
          </Button>
        </form>
        <form
          className="row key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void guard(() => vigil.setRelayToken(token));
          }}
        >
          <input
            className="input grow"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              view.token.saved ? 'Paste a new device token to replace it' : 'Paste the device token'
            }
            aria-label="Device token"
            value={token}
            disabled={disabled || busy}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button
            type="submit"
            kind="primary"
            size="sm"
            disabled={disabled || busy || !token.trim()}
          >
            Save
          </Button>
          {view.token.saved && (
            <Button
              kind="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => void guard(() => vigil.clearRelayToken())}
            >
              Remove
            </Button>
          )}
        </form>
        <div className="row" style={{ gap: 8 }}>
          <Chip tone={view.config.enabled && view.ready ? 'good' : undefined}>
            {view.config.enabled ? (view.ready ? status : 'Not ready') : 'Off'}
          </Chip>
          {view.token.saved && (
            <span className="t-small">
              Device token saved{view.token.last4 ? ` ···· ${view.token.last4}` : ''}
            </span>
          )}
          {view.status.lastAck && (
            <span className="t-small">Last accepted {timeAgo(view.status.lastAck.ts)}</span>
          )}
        </div>
        {disabled && (
          <span className="t-small">
            The Keychain isn’t available, so the token can’t be saved safely right now.
          </span>
        )}
        {error && (
          <span className="t-small" role="alert" style={{ color: 'var(--poor)' }}>
            {error}
          </span>
        )}
      </div>
    </>
  );
}

import { Segmented } from '../components/ui';
