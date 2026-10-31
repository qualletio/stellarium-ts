import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getComposerConversation, OperatorError } from '@/lib/api';
import { displayItems } from '@/lib/composer/events';
import { ComposerView } from '../ComposerView';

export const metadata: Metadata = { title: 'Composer' };

export default async function ComposerConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await getComposerConversation(id).catch((error) => {
    // A malformed id is a 400, someone else's conversation a 404.
    if (error instanceof OperatorError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  return <ComposerView conversationId={id} items={displayItems(loaded.messages)} />;
}
