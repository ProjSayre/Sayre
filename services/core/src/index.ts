import { createApp } from './app';

const PORT = Number(process.env.CORE_PORT ?? 4000);
createApp().listen(PORT, () => console.log(`[core] listening on :${PORT}`));
