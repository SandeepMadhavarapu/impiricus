import { AppBar } from "@/shared/components/AppBar";
import { ReceiveGuide } from "@/patient/components/ReceiveGuide";
export const metadata = { title: "Receive medication guide — MedBridge", robots: { index: false, follow: false } };
export default function ReceivePage() {
  return <main id="main" className="doctor-page"><AppBar subtitle="Receive medication guide" badge="Experimental" /><div className="doctor-workspace stack" style={{ maxWidth: 600, margin: "32px auto", padding: 16 }}><ReceiveGuide /></div></main>;
}
