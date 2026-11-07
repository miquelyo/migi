import ReactDOM from "react-dom/client";
import App from "./App";
import Settings from "./Settings";
import "./styles.css";

// Jendela utama menampilkan notch.
// Jendela pengaturan dibuka dari menu tray dengan alamat "index.html#settings".
// StrictMode sengaja tidak dipakai: efek ukuran jendela tidak boleh berjalan dua kali.
const isSettings = window.location.hash === "#settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  isSettings ? <Settings /> : <App />
);