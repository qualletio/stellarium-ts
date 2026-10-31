import Link from 'next/link';
import { Composer, type ComposerClient } from '@/components/Composer';
import styles from '@/components/Composer.module.css';
import { DeleteConversationButton } from '@/components/DeleteConversationButton';
import ui from '@/components/ui.module.css';
import { getOrganization, listClients, listComposerConversations, listListings, listNodes } from '@/lib/api';
import type { DisplayItem } from '@/lib/composer/events';
import { shortKey } from '@/lib/format';

/** The Composer page: the user's conversations beside one conversation, new when `conversationId` is omitted. */
export async function ComposerView({ conversationId, items = [] }: { conversationId?: string; items?: DisplayItem[] }) {
  const [organization, clients, listings, nodes, conversations] = await Promise.all([
    getOrganization(), listClients(), listListings(), listNodes(), listComposerConversations(),
  ]);
  const nodeName = (publicKey: string) => listings.find((listing) => listing.publicKey === publicKey)?.name
    ?? nodes.find((node) => node.publicKey === publicKey)?.name
    ?? nodes.find((node) => node.publicKey === publicKey)?.label
    ?? shortKey(publicKey);
  const composerClients: ComposerClient[] = clients
    .filter((client) => !client.revokedAt)
    .map((client) => ({ id: client.id, label: `${client.label ?? client.id} · ${nodeName(client.nodePublicKey)}` }));

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Composer</h1>
        {conversationId && (
          <span className={ui.actions}>
            <DeleteConversationButton id={conversationId} />
            <Link href="/composer" className={ui.buttonSecondary}>New conversation</Link>
          </span>
        )}
      </header>
      <div className={styles.layout}>
        <nav className={styles.history} aria-label="Conversations">
          {conversations.length === 0 && <span className={ui.secondary}>No conversations yet.</span>}
          {conversations.map((conversation) => (
            <Link key={conversation.id} href={`/composer/${conversation.id}`} className={styles.historyLink}
              aria-current={conversation.id === conversationId ? 'page' : undefined} title={conversation.title}>
              {conversation.title}
            </Link>
          ))}
        </nav>
        <Composer
          // Opening another conversation starts over from its saved messages.
          key={conversationId ?? 'new'}
          clients={composerClients}
          conversationId={conversationId}
          initialItems={items}
          admin={organization.admin}
          availableMicroUsd={organization.availableMicroUsd}
        />
      </div>
    </>
  );
}
