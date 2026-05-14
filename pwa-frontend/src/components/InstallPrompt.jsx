import { useEffect, useState } from 'react';

export default function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('kaspi-sync-install-dismissed') === '1');
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    function onPrompt(event) {
      event.preventDefault();
      setInstallEvent(event);
      setDismissed(false);
    }

    function onInstalled() {
      setInstalled(true);
      setInstallEvent(null);
    }

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function install() {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => null);
    setInstallEvent(null);
  }

  function dismiss() {
    localStorage.setItem('kaspi-sync-install-dismissed', '1');
    setDismissed(true);
  }

  if (dismissed || installed || !installEvent) return null;

  return (
    <section className="install-card">
      <div className="install-mark">KS</div>
      <div>
        <strong>Установить Kaspi Sync</strong>
        <span>Откройте оплату кредита как банковское PWA-приложение.</span>
      </div>
      <button type="button" onClick={install}>Установить</button>
      <button className="icon-button small" type="button" aria-label="Скрыть установку" onClick={dismiss}>x</button>
    </section>
  );
}
