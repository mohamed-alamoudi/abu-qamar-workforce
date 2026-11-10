import type { MetadataRoute } from 'next';

/** Web App Manifest — أساس الـ PWA (Service Worker والعمل دون إنترنت في المرحلة السادسة). */
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
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
