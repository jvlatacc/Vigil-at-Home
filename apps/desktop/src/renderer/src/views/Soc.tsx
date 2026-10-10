import { useState } from 'react';
import { Send } from 'lucide-react';
import type { SocSettingsPatch } from '../../../shared/soc';
import { useLive, vigil } from '../api';
import { useToast } from '../components/Toasts';
import { Button, SectionHead, Segmented } from '../components/ui';

/**
 * The SOC export card. Off until you turn it on: an address for your SOC and
 * an API key from it, stored encrypted in the Keychain like every other key.
 * While it is on, each alert is sent there — redacted first, only what an
 * investigation needs — and resolving the alert at home closes the finding
 * in the SOC. Turn it off and Vigil stays a personal SOC that talks to no one.
 */
export function SocSection() {
  const [view, reload] = useLive(() => vigil.getSoc());
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const head = (
    <SectionHead
      title="SOC export"
      sub="Share alerts with a Vigil SOC you run, so its agents can investigate them. Everything is redacted here first, and nothing is sent while this is off."
    />
  );
  if (!view) return head;
  const busySave = busy;

  const save = async (patch: SocSettingsPatch, done: string) => {
    setBusy(true);
    try {
      const next = await vigil.setSoc(patch);
      setKey('');
      setUrl('');
      reload();
      if (next.enabled) toast({ text: done });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {head}
      <div className="row spread">
        <span>Send alerts to your SOC</span>
        <Segmented
          label="SOC export"
          value={view.enabled ? 'on' : 'off'}
          disabled={busySave}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ]}
          onChange={async (v) => {
            const on = v === 'on';
            if (on === view.enabled) return;
            // Turning on needs an address and a key in the fields; the store
            // explains what is missing if either is absent.
            await save(
              on ? { enabled: true, socBaseUrl: url.trim(), socApiKey: key } : { enabled: false },
              on ? 'Alerts are being sent to your SOC' : 'SOC export is off — nothing is sent',
            );
          }}
        />
      </div>
      {view.enabled && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="mono">{view.socBaseUrl}</span>
          {view.keySaved && <span>Key ·· {view.keyLast4}</span>}
          <Button
            size="sm"
            icon={<Send size={14} />}
            disabled={busy}
            onClick={async () => {
              await vigil.flushSoc();
              toast({ text: 'Sent everything waiting' });
            }}
          >
            Send now
          </Button>
          <Button
            size="sm"
            kind="ghost"
            disabled={busy || !view.keySaved}
            onClick={async () => {
              await vigil.clearSocKey();
              reload();
              toast({ text: 'Key removed — export is off' });
            }}
          >
            Remove the key
          </Button>
        </div>
      )}
      {!view.enabled && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input
            className="input grow"
            type="url"
            placeholder="https://soc.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="SOC address"
          />
          <input
            className="input grow"
            type="password"
            placeholder="API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="SOC API key"
          />
        </div>
      )}
      {view.errors.map((e) => (
        <p key={e} className="t-small" style={{ color: 'var(--warn, #b45309)' }}>
          {e}
        </p>
      ))}
    </div>
  );
}
