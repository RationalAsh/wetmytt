import './globals.css';
export const metadata = { title: 'Decklet', description: 'Presentations, in plain files.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
