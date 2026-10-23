import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The default bottom-left badge covers the sidebar's account menu.
  devIndicators: { position: 'bottom-right' },
};

export default nextConfig;
