import type { Metadata } from 'next';
import { ComposerView } from './ComposerView';

export const metadata: Metadata = { title: 'Composer' };

export default function ComposerPage() {
  return <ComposerView />;
}
