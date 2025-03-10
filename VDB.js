// Fungsi untuk membuat spinner
function startSpinner() {
    const spinnerChars = ['oh', 'my', 'faiz', '**']; // Karakter spinner
    let index = 0; // Indeks untuk karakter spinner

    // Menggunakan setInterval untuk memperbarui spinner setiap 100ms
    const interval = setInterval(() => {
        // Menghapus karakter sebelumnya
        process.stdout.write('\r' + spinnerChars[index++ % spinnerChars.length]);
    }, 100);

    // Mengembalikan fungsi untuk menghentikan spinner
    return () => clearInterval(interval);
}

// Memulai spinner
const stopSpinner = startSpinner();

// Simulasi proses yang memakan waktu
setTimeout(() => {
    // Menghentikan spinner setelah 5 detik
    stopSpinner();
    console.log('\nProses selesai!'); // Menampilkan pesan selesai
}, 10000);
