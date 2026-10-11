# HOLO HAND STUDIO

Aplikasi web statis: menggambar di udara & kontrol hologram dengan telunjuk (MediaPipe Hands).

## Struktur
```
holo-hand-studio/
├── index.html
├── style.css
├── script.js
└── README.md
```

## Internet
Library MediaPipe (`@mediapipe/tasks-vision@0.10.14`, jsDelivr) dan model `hand_landmarker.task` (Google Storage) dimuat dari internet saat kamera pertama diaktifkan. Video TIDAK diunggah — semua proses di browser.

## SPCK
1. Buat proyek baru "holo-hand-studio".
2. Buat 4 file dengan nama persis di atas, salin isinya.
3. Preview SPCK biasanya `localhost` → kamera boleh. Jika tidak, host via HTTPS.

## Hosting HTTPS gratis
- GitHub Pages: upload file ke repo → Settings → Pages → branch main.
- Netlify Drop (app.netlify.com/drop): seret folder.
Buka URL `https://...` di Chrome Android.

## Cara pakai & uji
- **Aktifkan Kamera** → izinkan. Status kamera hijau, lalu "Tangan: terdeteksi" saat tangan masuk.
- **Mode Normal**: penunjuk + kerangka tangan + partikel. Kepal/buka tangan = efek pulse. Tidak ada garis.
- **Mode Gambar**: angkat **telunjuk saja** (jari lain ditekuk) → mulai menggambar setelah ~3 frame stabil. Buka telapak/kepal → berhenti. Alternatif: tahan tombol **Tahan untuk Gambar**.
- **Undo** menghapus goresan terakhir; **Hapus Semua** minta konfirmasi.
- Tangan keluar kamera → goresan berakhir, gambar tetap ada.
- Ganti mode tidak menghapus gambar dan tidak menyambung garis.
- **Ganti Kamera** aktif bila ada >1 kamera. **Fullscreen** bila didukung.

## Catatan bug yang ditangani
- Garis tidak tersambung antar goresan: setiap mulai = stroke baru; hilang tangan/ganti mode/ganti warna = stroke diakhiri.
- Mode normal tidak pernah memanggil fungsi gambar; lapisan efek dibersihkan tiap frame.
- Kamera dimatikan → semua track dihentikan & loop animasi dibatalkan.
- Akurasi gesture tergantung cahaya & jarak; uji di kondisi terang.
