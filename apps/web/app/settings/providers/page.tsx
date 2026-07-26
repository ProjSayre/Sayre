import { redirect } from 'next/navigation';

export default function ProviderSettingsPage() {
  redirect('/?settings=providers');
}
