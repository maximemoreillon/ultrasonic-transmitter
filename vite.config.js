import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for microphone access on any origin other than localhost,
// so phones on the LAN need it. The self-signed cert triggers a one-time browser warning.
export default defineConfig({
  plugins: [basicSsl()],
});
