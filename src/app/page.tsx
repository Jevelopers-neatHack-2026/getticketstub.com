import { Landing } from "@/customer/landing/Landing";
import { StudioStart } from "@/customer/start/StudioStart";

export default function Home() {
  // the landing page's hero, then the studio start on the cream paper desk, then the rest of the landing page
  return (
    <Landing>
      <div id="start" className="desk-surface">
        <StudioStart />
      </div>
    </Landing>
  );
}
