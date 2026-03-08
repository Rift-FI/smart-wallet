import crypto, { createHash } from "node:crypto";
import { ethers } from 'ethers';

let key1="11eb3fc00ca3d318ae56b9146cfd7f2c:7899f935f95b6e668a67d21614ffbbbe31d1d83ef68c98e1da09dea7226a555f705435fcd8f52a680b83bfcda982c174a4eeb53e5f4d626a8086fa260da181449504141de75b267abc4a889f1ab9c962"
let key2="7b18a20583b47c049fc8a0b1b81c1e9e:107970b38ea040ee50abf700148bda3b3476be31cdb90992ec3eaef74d33a839c9f46a703ce7c54b9f207cb5cf65b78b064c086f65ecc20d14356fbd771a0125ed8a297f56c03d8b060474a645312258"
let secret="89b0dba4b7eacc5d778d516e671aff6ff4ff83a8dfd741f2f4bec1c6ba072f39"

export function decrypt(encryptedText, secretKey) {
    const key = createHash("sha256").update(String(secretKey)).digest();
    const parts = encryptedText.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedData = parts[1];
  
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
  
    let decrypted = decipher.update(encryptedData, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
  
    return decrypted;
}

// Decrypt both keys
const keys = [key1, key2];

keys.forEach((encryptedKey, index) => {
    const decryptedKey = decrypt(encryptedKey, secret);
    console.log(`Key ${index + 1}: ${decryptedKey}`);
});


// Key 1: 0x9063ce8ee9e97c18fd1e967ef7501ecd8a8d4266926b540c5438dbd0103089ec
// Key 2: 0x0c4ae579d361b31680723740efd2dd5db20267503546da0c7960749b69f5dcd3



function privateKeyToAddressEthers(privateKey) {
    // Remove 0x prefix if present
    if (privateKey.startsWith('0x')) {
        privateKey = privateKey.slice(2);
    }
    
    // Create wallet from private key
    const wallet = new ethers.Wallet(privateKey);
    
    return wallet.address;
}

// Example usage:
const privateKey = '0x0c4ae579d361b31680723740efd2dd5db20267503546da0c7960749b69f5dcd3';
console.log('Address:', privateKeyToAddressEthers(privateKey));
