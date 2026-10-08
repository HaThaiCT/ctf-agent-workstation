output "instance_name" {
  value = digitalocean_droplet.ctf.name
}

output "external_ip" {
  value = digitalocean_droplet.ctf.ipv4_address
}

output "webapp_url" {
  value       = "http://127.0.0.1:8000"
  description = "Open locally after forwarding SSH port 8000 to the VM."
}
