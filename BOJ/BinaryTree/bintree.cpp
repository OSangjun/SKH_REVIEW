// https://www.acmicpc.net/problem/9375
// 18-08-16 21 :45 ~ 
#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>

struct node {
	int key;
	node* l, *r;
	node(int k = -1, node* _l=NULL, node* _r=NULL) {
		l = _l;
		r = _r;
		key = k;
	}
}; 

int addNode(node* root, int key) {
	if (root->key > key) {
		if (root->l) { // go to left
			addNode(root->l, key);
		}
		else { // add at left
			root->l = new node(key);
		}
	}
	else if (root->key < key ) {
		if (root->r) {// go to right
			addNode(root->r, key);
		}
		else { // add at right
			root->r = new node(key);
		}
	}
	return 0;
}

void post(node* root) {
	if (root->l) { // go to left
		post(root->l);
	}
	if (root->r) { // go to right
		post(root->r);
	}
	printf("%d ", root->key);
}

int main() {
	char tmp[7*10000+1];
	int val,idx =0;
	int cnt = 0;
	scanf("%d\n", &val);
	node* root = new node(val);
	// make tree
	while (EOF != scanf("%d", &val)) {
		//val = atoi(tmp); 
		addNode(root, val);
		//post(root);
	}

	// Post-order traversal
	post(root);

#ifdef _DEBUG
	system("pause");
#endif

	return 0;
}


