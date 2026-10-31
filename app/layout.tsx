import './globals.css';
export const metadata = { title: 'Welcome to my Talk', description: 'Got a point? Make it. AI-first presentations, in plain files.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
