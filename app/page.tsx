import { getChatGPTUser } from "./chatgpt-auth";
import DemandBoard from "./demand-board";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();

  return (
    <DemandBoard
      currentUser={{
        name: user?.displayName ?? "Rian Oliveira",
        email: user?.email ?? "rian@filadp.local",
        role: "admin",
      }}
    />
  );
}
