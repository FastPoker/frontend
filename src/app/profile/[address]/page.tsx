import { PublicProfilePage } from '@/components/profile/PublicProfilePage';

export const dynamicParams = false;

export async function generateStaticParams(): Promise<Array<{ address: string }>> {
  return [];
}

export default async function WalletProfilePage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <PublicProfilePage address={address} />;
}
