import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'نظام إدارة موظفي سوبر ماركت أبو قمر',
    short_name: 'موظفو أبو قمر',
    description: 'إدارة الموظفين والحضور والانصراف والرواتب',
    lang: 'ar',
    dir: 'rtl',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#f3f5f9',
    theme_color: '#244b90',
    icons: [
      { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
