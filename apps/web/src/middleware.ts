import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIES = ['__Host-aq_session', 'aq_session'];
const PUBLIC_PATHS = ['/login', '/setup'];

/**
 * توجيه مبدئي لتحسين التجربة: من لا يحمل كوكي جلسة يُرسل إلى صفحة الدخول.
 * هذا ليس حاجزًا أمنيًا — التحقق الفعلي من الجلسة والصلاحيات يتم في الخادم مع كل طلب.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (pathname === '/') {
    return NextResponse.redirect(new URL(hasSession ? '/dashboard' : '/login', request.url));
  }
  if (!hasSession && !PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = new URL('/login', request.url);
    if (pathname !== '/dashboard') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // كل الصفحات عدا مسارات الـ API والملفات الثابتة
  matcher: ['/((?!api/|_next/|icon.svg|manifest.webmanifest|favicon.ico).*)'],
};
